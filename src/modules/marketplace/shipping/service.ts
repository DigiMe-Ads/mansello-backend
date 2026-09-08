import { prisma } from "@/db/prisma";

// Matches the frontend's FLAT_SHIPPING_FEE fallback (src/lib/shipping.ts) —
// used only when every configured band is priced at 0, which the admin grid
// ships with by default and treats as "not configured yet" rather than
// "shipping is free". See BACKEND_CHANGES_SHIPPING_FLAT_BAND_PRICING.md.
const FALLBACK_FLAT_FEE = 5;

export function listShippingRates() {
  return prisma.shippingRate.findMany({ orderBy: { fromKg: "asc" } });
}

// Bulk replace — ShippingRate rows have no natural stable identity to
// upsert against (unlike PricingTier's [propertyId, guestCount, rooms]
// unique key), since an admin reconfiguring the bands can freely change
// how many rows exist and where they start/end. Delete-all-then-recreate
// in one transaction, same as any other "the whole set is the new set"
// admin save.
//
// Accepts either `price` (current) or the old `pricePerKg` name for one
// release, so this backend and a not-yet-redeployed frontend (or vice
// versa) both keep working during rollout — see
// BACKEND_CHANGES_SHIPPING_FLAT_BAND_PRICING.md §2. Drop the `pricePerKg`
// fallback once both sides are confirmed on the new name.
export async function replaceShippingRates(
  rates: { fromKg: number; toKg: number; price?: number; pricePerKg?: number }[]
) {
  const normalized = rates.map((r) => ({
    fromKg: r.fromKg,
    toKg: r.toKg,
    price: r.price ?? r.pricePerKg ?? 0,
  }));
  await prisma.$transaction([
    prisma.shippingRate.deleteMany({}),
    prisma.shippingRate.createMany({ data: normalized }),
  ]);
  return listShippingRates();
}

// Server-side source of truth for an order's shipping fee — computed from
// the submitted items' weight and the current ShippingRate table, never
// trusted from the client (closes the gap BACKEND_PLAN.md §7 left open,
// where CreateOrderInput.shippingFee was a flat, client-supplied constant).
// See BACKEND_CHANGES_PRICING_DISCOUNTS_SHIPPING.md §4 and
// BACKEND_CHANGES_SHIPPING_FLAT_BAND_PRICING.md for the current algorithm.
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
  // A $0 row means "not filled in yet", not "this weight ships free" — the
  // admin grid ships with every band at 0, and a still-zero row is
  // excluded from band selection entirely rather than being a real
  // candidate (confirmed against the doc's own test vectors: with bands
  // 1–3kg priced and 4–15kg left at 0, a 5kg order must resolve to the
  // 3kg band's price via the "above every [configured] band" rule, not to
  // the literal 5kg row's $0). If nothing is priced at all, fall back to
  // the same flat fee the frontend's checkout preview uses instead of
  // disagreeing with it.
  const configuredRates = rates.filter((r) => Number(r.price) !== 0);
  if (configuredRates.length === 0) return FALLBACK_FLAT_FEE;

  return Number(pickShippingRate(roundedWeightKg, configuredRates).price);
}

interface ShippingRateRow {
  fromKg: number;
  toKg: number;
  price: unknown;
}

// BACKEND_CHANGES_SHIPPING_FLAT_BAND_PRICING.md §3 — the band's `price` IS
// the fee (no multiplication by weight; see the ShippingRate model comment
// for why that used to be wrong). Band selection itself is unchanged from
// the BACKEND_CHANGES_SEO_SECURITY_HARDENING.md §2.2 fix:
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
