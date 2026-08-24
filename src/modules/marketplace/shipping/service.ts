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

  const matched = rates.find((r) => roundedWeightKg >= r.fromKg && roundedWeightKg <= r.toKg);
  // Exceeds every configured band's toKg — use the highest band's
  // pricePerKg for the excess, per the doc (no data to price it any other
  // way until the admin adds more rows). Symmetrically, a weight below
  // every band's fromKg (e.g. bands start at 2kg) uses the lowest band's
  // rate rather than going unpriced.
  const rate = matched ?? (roundedWeightKg > rates[rates.length - 1].toKg ? rates[rates.length - 1] : rates[0]);

  return roundedWeightKg * Number(rate.pricePerKg);
}
