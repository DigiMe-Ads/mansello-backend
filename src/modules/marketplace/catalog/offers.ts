import { Prisma, ProductOffer } from "@prisma/client";
import { prisma } from "@/db/prisma";
import { ApiError } from "@/utils/ApiError";

// Time-limited % off a product, or one of its variations (see the
// ProductOffer model). Every price the shop shows or charges comes through
// here: the storefront gets `salePriceUsd` per product/variation, and
// checkout re-prices each line with the same rule, so a cart can never be
// charged an offer that has ended (or miss one that has started).

type Db = Prisma.TransactionClient | typeof prisma;

export interface OfferInput {
  variantId?: string | null;
  title?: string | null;
  discountPercent: number;
  startsAt: Date;
  endsAt: Date;
  active?: boolean;
}

/** Offers running at `now`, for these products. */
export function runningOffers(db: Db, productIds: string[], now = new Date()) {
  if (productIds.length === 0) return Promise.resolve([] as ProductOffer[]);
  return db.productOffer.findMany({
    where: { productId: { in: productIds }, active: true, startsAt: { lte: now }, endsAt: { gt: now } },
  });
}

/**
 * The best running offer for one sellable line: a variation's own offer or
 * a product-wide one (variantId null), whichever takes more off.
 */
export function bestOffer(offers: ProductOffer[], productId: string, variantId: string | null) {
  let best: ProductOffer | null = null;
  for (const o of offers) {
    if (o.productId !== productId) continue;
    if (o.variantId !== null && o.variantId !== variantId) continue;
    if (!best || o.discountPercent > best.discountPercent) best = o;
  }
  return best;
}

export function discounted(price: number, percent: number) {
  return Math.round(price * (100 - percent)) / 100;
}

type PriceFields = { salePriceUsd: number | null; offerPercent: number | null; offerTitle: string | null; offerEndsAt: Date | null };

function priceFields(price: Prisma.Decimal | number, offer: ProductOffer | null): PriceFields {
  if (!offer) return { salePriceUsd: null, offerPercent: null, offerTitle: null, offerEndsAt: null };
  return {
    salePriceUsd: discounted(Number(price), offer.discountPercent),
    offerPercent: offer.discountPercent,
    offerTitle: offer.title,
    offerEndsAt: offer.endsAt,
  };
}

/**
 * Adds sale-price fields to products (and each of their variations) for the
 * offers running now. `salePriceUsd` is null when nothing is on offer.
 */
export async function withOfferPrices<
  T extends { id: string; priceUsd: Prisma.Decimal; variants: { id: string; priceUsd: Prisma.Decimal }[] }
>(products: T[]) {
  const offers = await runningOffers(prisma, products.map((p) => p.id));
  return products.map((p) => ({
    ...p,
    ...priceFields(p.priceUsd, bestOffer(offers, p.id, null)),
    variants: p.variants.map((v) => ({ ...v, ...priceFields(v.priceUsd, bestOffer(offers, p.id, v.id)) })),
  }));
}

function assertRange(startsAt: Date, endsAt: Date) {
  if (endsAt <= startsAt) throw ApiError.badRequest("The offer must end after it starts");
}

async function assertVariantOf(productId: string, variantId: string | null | undefined) {
  if (!variantId) return;
  const variant = await prisma.productVariant.findUnique({ where: { id: variantId }, select: { productId: true } });
  if (!variant || variant.productId !== productId) throw ApiError.badRequest("That option doesn't belong to this product");
}

const offerInclude = {
  product: { select: { id: true, name: true, images: true, priceUsd: true } },
  variant: { select: { id: true, name: true, priceUsd: true } },
} as const;

/** Every offer, newest first, with the product/variation it applies to (admin). */
export function listOffers() {
  return prisma.productOffer.findMany({ include: offerInclude, orderBy: [{ startsAt: "desc" }] });
}

export async function createOffer(productId: string, input: OfferInput) {
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
  if (!product) throw ApiError.notFound("Product not found");
  assertRange(input.startsAt, input.endsAt);
  await assertVariantOf(productId, input.variantId);
  return prisma.productOffer.create({
    data: {
      productId,
      variantId: input.variantId || null,
      title: input.title?.trim() || null,
      discountPercent: input.discountPercent,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      active: input.active ?? true,
    },
    include: offerInclude,
  });
}

export async function updateOffer(id: string, input: Partial<OfferInput>) {
  const offer = await prisma.productOffer.findUnique({ where: { id } });
  if (!offer) throw ApiError.notFound("Offer not found");
  assertRange(input.startsAt ?? offer.startsAt, input.endsAt ?? offer.endsAt);
  if (input.variantId !== undefined) await assertVariantOf(offer.productId, input.variantId);
  return prisma.productOffer.update({
    where: { id },
    data: {
      ...(input.variantId !== undefined ? { variantId: input.variantId || null } : {}),
      ...(input.title !== undefined ? { title: input.title?.trim() || null } : {}),
      discountPercent: input.discountPercent,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      active: input.active,
    },
    include: offerInclude,
  });
}

export async function deleteOffer(id: string) {
  const offer = await prisma.productOffer.findUnique({ where: { id } });
  if (!offer) throw ApiError.notFound("Offer not found");
  await prisma.productOffer.delete({ where: { id } });
}
