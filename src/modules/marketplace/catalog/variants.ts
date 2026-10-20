import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/db/prisma";
import { ApiError } from "@/utils/ApiError";

// Product variations (e.g. 80ml / 100ml), each with its own SKU, price,
// weight and stock — BACKEND_CHANGES_VARIANTS_CALENDAR_PAYMENTS_LK.md §1.

type Db = Prisma.TransactionClient | typeof prisma;

export interface VariantInput {
  name: string;
  sku: string;
  priceUsd: number;
  weightKg?: number | null;
  initialStock: number;
  lowStockThreshold?: number;
  images?: string[];
}

const DEFAULT_LOW_STOCK_THRESHOLD = 5;

// Interactive transactions here make several sequential round trips to the
// database (Supabase, far from Railway); Prisma's 5s default was too short
// for a product with many variations (P2028 "Transaction already closed").
export const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

// How every response shapes a product's variants: ordered, with their stock.
// Public callers see only active ones.
export function variantsInclude(includeInactive: boolean) {
  return {
    variants: {
      where: includeInactive ? {} : { active: true },
      orderBy: { sortOrder: "asc" as const },
      include: { stockLevel: true },
    },
  };
}

// A SKU must be unique across products AND variants — the two unique
// indexes only cover their own table each. `except` lets an update keep its
// own current SKU.
export async function assertSkuFree(db: Db, sku: string, except: { productId?: string; variantId?: string } = {}) {
  const product = await db.product.findUnique({ where: { sku }, select: { id: true, name: true } });
  if (product && product.id !== except.productId) {
    throw ApiError.conflict(`SKU ${sku} is already used by the product "${product.name}"`);
  }
  const variant = await db.productVariant.findUnique({
    where: { sku },
    select: { id: true, name: true, product: { select: { name: true } } },
  });
  if (variant && variant.id !== except.variantId) {
    throw ApiError.conflict(`SKU ${sku} is already used by "${variant.product.name} (${variant.name})"`);
  }
}

// Same rule as assertSkuFree for many SKUs at once — two queries in total
// rather than two per SKU.
export async function assertSkusFree(db: Db, skus: string[]) {
  const [products, variants] = await Promise.all([
    db.product.findMany({ where: { sku: { in: skus } }, select: { sku: true, name: true } }),
    db.productVariant.findMany({
      where: { sku: { in: skus } },
      select: { sku: true, name: true, product: { select: { name: true } } },
    }),
  ]);
  if (products[0]) throw ApiError.conflict(`SKU ${products[0].sku} is already used by the product "${products[0].name}"`);
  if (variants[0]) {
    const v = variants[0];
    throw ApiError.conflict(`SKU ${v.sku} is already used by "${v.product.name} (${v.name})"`);
  }
}

function variantFields(v: VariantInput, sortOrder: number) {
  return {
    name: v.name.trim(),
    sku: v.sku.trim(),
    priceUsd: v.priceUsd,
    weightKg: v.weightKg ?? null,
    images: v.images ?? [],
    sortOrder,
  };
}

function stockFields(v: VariantInput) {
  return {
    quantityOnHand: v.initialStock,
    lowStockThreshold: v.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD,
  };
}

/**
 * Bulk-insert rows for a new product's variations and their stock: ids are
 * generated here so both tables can be written with one createMany each.
 */
export function variantBulkData(productId: string, variants: VariantInput[]) {
  const rows = variants.map((v, i) => ({ id: randomUUID(), v, sortOrder: i }));
  return {
    variants: rows.map(({ id, v, sortOrder }) => ({ id, productId, ...variantFields(v, sortOrder) })),
    stock: rows.map(({ id, v }) => ({ variantId: id, ...stockFields(v) })),
  };
}

// Names unique within the product, SKUs unique within the batch — checked
// up front so a create-with-variants fails with a clear message rather than
// half-way through on a constraint.
export function assertDistinctVariants(variants: { name: string; sku: string }[], productSku?: string) {
  const names = new Set<string>();
  const skus = new Set<string>(productSku ? [productSku] : []);
  for (const v of variants) {
    const key = v.name.trim().toLowerCase();
    if (names.has(key)) throw ApiError.badRequest(`Two variations are both named "${v.name}"`);
    names.add(key);
    if (skus.has(v.sku)) throw ApiError.conflict(`SKU ${v.sku} is used more than once`);
    skus.add(v.sku);
  }
}

export function createVariantRows(db: Db, productId: string, variants: VariantInput[], firstSortOrder = 0) {
  return Promise.all(
    variants.map((v, i) =>
      db.productVariant.create({
        data: { ...variantFields(v, firstSortOrder + i), productId, stockLevel: { create: stockFields(v) } },
        include: { stockLevel: true },
      })
    )
  );
}

// product.priceUsd mirrors the lowest ACTIVE variant price, so lists and
// "From $x" stay right. With no active variants it's left as it was.
export async function recomputeProductPrice(db: Db, productId: string) {
  const cheapest = await db.productVariant.findFirst({
    where: { productId, active: true },
    orderBy: { priceUsd: "asc" },
    select: { priceUsd: true },
  });
  if (cheapest) await db.product.update({ where: { id: productId }, data: { priceUsd: cheapest.priceUsd } });
}

async function getVariantOf(db: Db, productId: string, variantId: string) {
  const variant = await db.productVariant.findUnique({ where: { id: variantId } });
  // 404 also when the variant exists but belongs to another product.
  if (!variant || variant.productId !== productId) throw ApiError.notFound("Variation not found");
  return variant;
}

async function assertNameFree(db: Db, productId: string, name: string, exceptVariantId?: string) {
  const clash = await db.productVariant.findFirst({
    where: { productId, name: { equals: name.trim(), mode: "insensitive" }, id: { not: exceptVariantId } },
  });
  if (clash) throw ApiError.badRequest(`This product already has a variation named "${clash.name}"`);
}

// Adding the first variation converts the product to per-variation stock:
// from then on only variant stock rows are used (the product-level row is
// kept, untouched, in case every variation is later removed).
export async function createVariant(productId: string, input: VariantInput) {
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findUnique({ where: { id: productId } });
    if (!product) throw ApiError.notFound("Product not found");
    await assertNameFree(tx, productId, input.name);
    await assertSkuFree(tx, input.sku.trim());

    const last = await tx.productVariant.findFirst({
      where: { productId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    const [variant] = await createVariantRows(tx, productId, [input], (last?.sortOrder ?? -1) + 1);
    await recomputeProductPrice(tx, productId);
    return variant;
  }, TX_OPTIONS);
}

export async function updateVariant(
  productId: string,
  variantId: string,
  data: Partial<{
    name: string;
    sku: string;
    priceUsd: number;
    weightKg: number | null;
    active: boolean;
    sortOrder: number;
    lowStockThreshold: number;
    images: string[];
  }>
) {
  return prisma.$transaction(async (tx) => {
    await getVariantOf(tx, productId, variantId);
    if (data.name !== undefined) await assertNameFree(tx, productId, data.name, variantId);
    if (data.sku !== undefined) await assertSkuFree(tx, data.sku.trim(), { variantId });

    const { lowStockThreshold, ...fields } = data;
    await tx.productVariant.update({
      where: { id: variantId },
      data: {
        ...fields,
        ...(fields.name !== undefined ? { name: fields.name.trim() } : {}),
        ...(fields.sku !== undefined ? { sku: fields.sku.trim() } : {}),
      },
    });
    if (lowStockThreshold !== undefined) {
      await tx.stockLevel.upsert({
        where: { variantId },
        update: { lowStockThreshold },
        create: { variantId, quantityOnHand: 0, lowStockThreshold },
      });
    }
    await recomputeProductPrice(tx, productId);
    return tx.productVariant.findUniqueOrThrow({ where: { id: variantId }, include: { stockLevel: true } });
  }, TX_OPTIONS);
}

// Like products, a variation with order history can be deleted: its order
// lines keep their snapshots and their variantId is set to NULL by the FK.
export async function deleteVariant(productId: string, variantId: string) {
  await prisma.$transaction(async (tx) => {
    await getVariantOf(tx, productId, variantId);
    await tx.productVariant.delete({ where: { id: variantId } });
    await recomputeProductPrice(tx, productId);
  }, TX_OPTIONS);
}

// Conditional update, so concurrent adjustments can't take stock below 0.
export async function adjustVariantStock(productId: string, variantId: string, delta: number) {
  await getVariantOf(prisma, productId, variantId);
  return applyStockDelta({ variantId }, delta);
}

export async function applyStockDelta(owner: { productId: string } | { variantId: string }, delta: number) {
  const level = await prisma.stockLevel.findUnique({ where: owner as Prisma.StockLevelWhereUniqueInput });
  if (!level) throw ApiError.notFound("No stock record for this item");
  const changed = await prisma.stockLevel.updateMany({
    where: { id: level.id, quantityOnHand: { gte: delta < 0 ? -delta : 0 } },
    data: { quantityOnHand: { increment: delta } },
  });
  if (changed.count === 0) {
    const now = await prisma.stockLevel.findUniqueOrThrow({ where: { id: level.id } });
    throw ApiError.badRequest(`Stock can't go below 0 — only ${now.quantityOnHand} on hand`);
  }
  return prisma.stockLevel.findUniqueOrThrow({ where: { id: level.id } });
}
