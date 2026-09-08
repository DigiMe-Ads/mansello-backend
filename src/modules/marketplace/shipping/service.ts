import { prisma } from "@/db/prisma";

export function listShippingRates() {
  return prisma.shippingRate.findMany({ orderBy: { fromKg: "asc" } });
}

// Bulk replace — ShippingRate rows have no natural stable identity to
// upsert against (unlike PricingTier's [propertyId, guestCount, rooms]
// unique key), since an admin reconfiguring the bands can freely change
// how many rows exist and where they start/end. Delete-all-then-recreate
// in one transaction, same as any other "the whole set is the new set"
// admin save.
export async function replaceShippingRates(rates: { fromKg: number; toKg: number; pricePerKg: number }[]) {
  await prisma.$transaction([
    prisma.shippingRate.deleteMany({}),
    prisma.shippingRate.createMany({ data: rates }),
  ]);
  return listShippingRates();
}

// Server-side source of truth for an order's shipping fee — computed from
// the submitted items' weight and the current ShippingRate table, never
// trusted from the client (closes the gap BACKEND_PLAN.md §7 left open,
// where CreateOrderInput.shippingFee was a flat, client-supplied constant).
// See BACKEND_CHANGES_PRICING_DISCOUNTS_SHIPPING.md §4.
export async function computeShippingFee(
  items: { productId: string; quantity: number }[],
  products: { id: string; weightKg: unknown }[]
): Promise<number> {
  if (items.length === 0) return 0;

  const totalWeightKgRaw = items.reduce((sum, item) => {
    const product = products.find((p) => p.id === item.productId);
    // null/absent weightKg (a product created before this field existed) is
    // treated as 0kg — still counts toward the cart being non-empty below.
    const weight = product?.weightKg ? Number(product.weightKg) : 0;
    return sum + weight * item.quantity;
  }, 0);

  // Rounded up, minimum 1kg once the cart is non-empty (even an all-0kg
  // cart still gets charged the 1kg band) — matches the frontend's
  // src/lib/shipping.ts exactly, so the checkout preview and the actual
  // charge agree.
  const roundedWeightKg = Math.max(1, Math.ceil(totalWeightKgRaw));

  const rates = await prisma.shippingRate.findMany({ orderBy: { fromKg: "asc" } });
  // No bands configured at all — nothing to price against. $0 rather than
  // silently trusting a client-sent value (that's exactly the gap this is
  // closing) or guessing at a fallback constant this module doesn't own.
  if (rates.length === 0) return 0;

  const rate = pickShippingRate(roundedWeightKg, rates);
  return roundedWeightKg * Number(rate.pricePerKg);
}

interface ShippingRateRow {
  fromKg: number;
  toKg: number;
  pricePerKg: unknown;
}

// BACKEND_CHANGES_SEO_SECURITY_HARDENING.md §2.2 — two bugs fixed here,
// both only reachable with admin-configured bands that aren't a single
// contiguous, non-overlapping run (freely possible via replaceShippingRates,
// so a realistic data-entry outcome, not a hypothetical):
//
// (a) A weight in a *gap* between bands (e.g. bands 1–3kg and 6–10kg, a 4kg
//     order) used to fall through to `rates[0]` — whichever band happens to
//     have the lowest fromKg — instead of the nearest band actually below
//     it. Now: the nearest band whose toKg is still < the weight.
// (b) "Is this weight above every band?" used to compare against
//     `rates[rates.length - 1]` — since `rates` is sorted by fromKg, that's
//     the band that *starts* highest, not necessarily the one that *ends*
//     highest (overlapping bands can disagree on those). Now: the band with
//     the highest toKg, found explicitly rather than assumed from sort order.
export function pickShippingRate(roundedKg: number, rates: ShippingRateRow[]): ShippingRateRow {
  // 1. A band that actually contains this weight.
  const exact = rates.find((r) => roundedKg >= r.fromKg && roundedKg <= r.toKg);
  if (exact) return exact;

  // 2. Above every band — the band with the highest toKg (fix (b)) prices
  //    the excess; there's no data to price it any other way.
  const top = rates.reduce((max, r) => (r.toKg > max.toKg ? r : max), rates[0]);
  if (roundedKg > top.toKg) return top;

  // 3. In a gap between bands — the nearest band strictly below (fix (a)),
  //    not just whichever band sorts first.
  const below = rates.filter((r) => r.toKg < roundedKg);
  if (below.length > 0) {
    return below.reduce((nearest, r) => (r.toKg > nearest.toKg ? r : nearest), below[0]);
  }

  // 4. Below every band's range entirely (e.g. bands start at 2kg) — the
  //    lowest band's rate, symmetric with case 2.
  return rates.reduce((min, r) => (r.fromKg < min.fromKg ? r : min), rates[0]);
}
