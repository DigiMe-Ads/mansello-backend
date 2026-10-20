import { createHmac, randomUUID } from "crypto";
import { Prisma, type StockLevel } from "@prisma/client";
import { prisma } from "@/db/prisma";
import { env } from "@/config/env";
import { ApiError } from "@/utils/ApiError";
import { slugify } from "@/utils/slugify";
import { hasVisibleText, sanitizeDescription } from "@/utils/richText";
import {
  VariantInput,
  applyStockDelta,
  assertDistinctVariants,
  assertSkusFree,
  variantBulkData,
  variantsInclude,
} from "./variants";
import { withOfferPrices } from "./offers";

// Flat list — each row carries parentId (null for a top-level category) and
// the frontend builds the one-level tree itself.
export function listCategories() {
  return prisma.category.findMany({ orderBy: { name: "asc" } });
}

const MAX_FEATURED_CATEGORIES = 4;

export interface CategoryInput {
  name: string;
  slug?: string;
  description?: string | null;
  imageUrl?: string | null;
  featured?: boolean;
  parentId?: string | null;
}

// Subcategories nest exactly one level deep: a parent must exist and be
// top-level itself.
async function assertValidParent(parentId: string) {
  const parent = await prisma.category.findUnique({ where: { id: parentId } });
  if (!parent) throw ApiError.badRequest("Parent category not found");
  if (parent.parentId) {
    throw ApiError.badRequest(
      `"${parent.name}" is already a subcategory — subcategories can't have subcategories`
    );
  }
}

export async function createCategory(input: CategoryInput) {
  if (!input.name?.trim()) throw ApiError.badRequest("name is required");
  const slug = input.slug?.trim() ? slugify(input.slug) : slugify(input.name);
  if (!slug) throw ApiError.badRequest("Could not derive a valid slug from name");

  const existing = await prisma.category.findUnique({ where: { slug } });
  if (existing) throw ApiError.conflict(`A category with slug "${slug}" already exists`);

  if (input.featured) await assertFeaturedRoom();
  if (input.parentId) await assertValidParent(input.parentId);

  return prisma.category.create({
    data: {
      name: input.name.trim(),
      slug,
      description: input.description,
      imageUrl: input.imageUrl,
      featured: input.featured ?? false,
      parentId: input.parentId || null,
    },
  });
}

export function getCategory(id: string) {
  return prisma.category.findUnique({ where: { id } });
}

// The frontend also soft-guards this (disables the checkbox once 4 others
// are already featured), but that's advisory only — this is the actual
// enforcement. excludeId lets an update re-save a category that's already
// one of the 4 without tripping over itself.
async function assertFeaturedRoom(excludeId?: string) {
  const featuredCount = await prisma.category.count({
    where: { featured: true, ...(excludeId ? { id: { not: excludeId } } : {}) },
  });
  if (featuredCount >= MAX_FEATURED_CATEGORIES) {
    throw ApiError.conflict(`At most ${MAX_FEATURED_CATEGORIES} categories can be featured at once`);
  }
}

// parentId: absent = unchanged, null = move back to top level, a string =
// make (or keep) this a subcategory of that category.
export async function updateCategory(
  id: string,
  data: Partial<{
    name: string;
    description: string | null;
    imageUrl: string | null;
    featured: boolean;
    parentId: string | null;
  }>
) {
  const existing = await prisma.category.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound("Category not found");

  if (data.featured && !existing.featured) await assertFeaturedRoom(id);

  if (data.parentId) {
    if (data.parentId === id) throw ApiError.badRequest("A category can't be its own parent");
    const childCount = await prisma.category.count({ where: { parentId: id } });
    if (childCount > 0) {
      throw ApiError.badRequest(
        "This category has subcategories, so it can't become a subcategory itself — move them first"
      );
    }
    await assertValidParent(data.parentId);
  } else if (data.parentId === "") {
    data.parentId = null;
  }

  return prisma.category.update({ where: { id }, data });
}

// categoryId is required on Product, so a category can't just be deleted out
// from under its products — the FK would reject it anyway, but a pre-check
// gives a clear message instead of a raw constraint error. Delete/reassign
// the products first, then the now-empty category.
export async function deleteCategory(id: string) {
  const category = await prisma.category.findUnique({ where: { id } });
  if (!category) throw ApiError.notFound("Category not found");

  const childCount = await prisma.category.count({ where: { parentId: id } });
  if (childCount > 0) {
    throw ApiError.conflict(
      `This category still has ${childCount} subcategor${childCount === 1 ? "y" : "ies"} — move or delete its subcategories first`
    );
  }

  const productCount = await prisma.product.count({ where: { categoryId: id } });
  if (productCount > 0) {
    throw ApiError.conflict(
      `This category still has ${productCount} product(s) — delete or move them first`
    );
  }

  await prisma.category.delete({ where: { id } });
}

// Same dual-purpose shape as blog's listPosts (API_DOCUMENTATION.md §10) —
// public/no-token callers (the storefront) only ever see active products;
// a super_admin/marketplace_manager token includes inactive ones too, so
// the admin product list can actually find (and reassign/delete) a
// deactivated product — otherwise it's invisible and permanently stuck
// blocking its category's deletion.
//
// A top-level category's slug also matches its subcategories' products; a
// subcategory's slug matches only its own (nesting is one level deep, so a
// subcategory never has children of its own to match).
export async function listProducts(categorySlug?: string, includeInactive = false) {
  const products = await prisma.product.findMany({
    where: {
      ...(includeInactive ? {} : { active: true }),
      ...(categorySlug
        ? { category: { OR: [{ slug: categorySlug }, { parent: { slug: categorySlug } }] } }
        : {}),
    },
    include: { category: true, stockLevel: true, ...variantsInclude(includeInactive) },
    orderBy: { createdAt: "desc" },
  });
  return withRatings(await withOfferPrices(products));
}

// Same admin-branch as listProducts, for consistency — an inactive product
// 404s for a public/non-admin caller now instead of being reachable by
// anyone who has (or guesses) its id.
export async function getProduct(id: string, includeInactive = false) {
  const product = await prisma.product.findFirst({
    where: { id, ...(includeInactive ? {} : { active: true }) },
    include: { category: true, stockLevel: true, ...variantsInclude(includeInactive) },
  });
  if (!product) return null;
  const [withRating] = await withRatings(await withOfferPrices([product]));
  return withRating;
}

// averageRating (null when unreviewed) + reviewCount on each product, from
// one grouped aggregate for the whole list rather than a query per product.
async function withRatings<T extends { id: string }>(products: T[]) {
  const stats = products.length
    ? await prisma.productReview.groupBy({
        by: ["productId"],
        where: { productId: { in: products.map((p) => p.id) } },
        _avg: { rating: true },
        _count: { _all: true },
      })
    : [];
  const byProduct = new Map(stats.map((s) => [s.productId, s]));
  return products.map((p) => {
    const s = byProduct.get(p.id);
    return { ...p, averageRating: s?._avg.rating ?? null, reviewCount: s?._count._all ?? 0 };
  });
}

// The description is WYSIWYG HTML — sanitized on every write, and
// "required" means it has visible text once tags are stripped (so "<br>"
// alone, or text that only lived inside a <script>, is rejected).
function cleanDescription(description: unknown): string {
  const clean = typeof description === "string" ? sanitizeDescription(description) : "";
  if (!hasVisibleText(clean)) throw ApiError.badRequest("description is required");
  return clean;
}

// "Get it within X–Y days" — both bounds or neither, min ≤ max.
export interface DeliveryEstimateInput {
  deliveryEstimateEnabled?: boolean;
  deliveryMinDays?: number | null;
  deliveryMaxDays?: number | null;
}

function assertDeliveryEstimate(d: DeliveryEstimateInput, current?: DeliveryEstimateInput) {
  const enabled = d.deliveryEstimateEnabled ?? current?.deliveryEstimateEnabled ?? false;
  const min = d.deliveryMinDays !== undefined ? d.deliveryMinDays : current?.deliveryMinDays;
  const max = d.deliveryMaxDays !== undefined ? d.deliveryMaxDays : current?.deliveryMaxDays;
  if (enabled && (min == null || max == null)) {
    throw ApiError.badRequest("Set both the earliest and latest delivery day to show a delivery estimate");
  }
  if (min != null && max != null && min > max) {
    throw ApiError.badRequest("The earliest delivery day can't be after the latest");
  }
}

// With `variants`, the product and every variation (each with its own stock)
// are created in one transaction; the product-level initialStock /
// lowStockThreshold / weightKg are ignored and priceUsd is the lowest
// variation price. Without, a plain product exactly as before.
export async function createProduct(input: {
  categoryId: string;
  name: string;
  description: string;
  priceUsd?: number;
  images: string[];
  sku: string;
  initialStock: number;
  lowStockThreshold?: number;
  weightKg?: number | null;
  variants?: VariantInput[];
} & DeliveryEstimateInput) {
  const description = cleanDescription(input.description);
  assertDeliveryEstimate(input);
  const variants = input.variants ?? [];

  assertDistinctVariants(variants, input.sku);
  await assertSkusFree(prisma, [input.sku, ...variants.map((v) => v.sku.trim())]);

  // Three statements in one batch transaction — the product, then every
  // variation, then every stock row — however many variations there are.
  // (This used to be an interactive transaction with a round trip per
  // variation, which ran past Prisma's 5s limit for products with several
  // variations — P2028.) A SKU taken by a concurrent request between the
  // check above and this write still fails on the unique index, reported as
  // the same conflict.
  try {
    const base = {
      categoryId: input.categoryId,
      name: input.name,
      description,
      images: input.images,
      sku: input.sku,
      deliveryEstimateEnabled: input.deliveryEstimateEnabled ?? false,
      deliveryMinDays: input.deliveryMinDays ?? null,
      deliveryMaxDays: input.deliveryMaxDays ?? null,
    };

    if (variants.length === 0) {
      return await prisma.product.create({
        data: {
          ...base,
          priceUsd: input.priceUsd!,
          weightKg: input.weightKg,
          stockLevel: {
            create: {
              quantityOnHand: input.initialStock,
              lowStockThreshold: input.lowStockThreshold ?? 5,
            },
          },
        },
        include: { stockLevel: true, ...variantsInclude(true) },
      });
    }

    const productId = randomUUID();
    const rows = variantBulkData(productId, variants);
    await prisma.$transaction([
      prisma.product.create({
        data: { ...base, id: productId, priceUsd: Math.min(...variants.map((v) => v.priceUsd)), weightKg: null },
      }),
      prisma.productVariant.createMany({ data: rows.variants }),
      prisma.stockLevel.createMany({ data: rows.stock }),
    ]);
    return await prisma.product.findUniqueOrThrow({
      where: { id: productId },
      include: { stockLevel: true, ...variantsInclude(true) },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw ApiError.conflict("One of these SKUs was just taken by another product — please use a different SKU");
    }
    throw err;
  }
}

export async function updateProduct(
  id: string,
  data: Partial<{
    categoryId: string;
    name: string;
    description: string;
    priceUsd: number;
    images: string[];
    active: boolean;
    weightKg: number | null;
  }> &
    DeliveryEstimateInput
  // Same trust level as createProduct — categoryId isn't pre-validated
  // against Category here either; an unknown id surfaces as the FK
  // constraint rejecting the write, not a clean ApiError. Lets an admin
  // move a product to another category, e.g. to empty one out before
  // deleting it (see deleteCategory above).
) {
  if (data.description !== undefined) data.description = cleanDescription(data.description);
  const current = await prisma.product.findUnique({ where: { id } });
  if (!current) throw ApiError.notFound("Product not found");
  assertDeliveryEstimate(data, current);
  return prisma.product.update({ where: { id }, data });
}

// Past orders don't depend on the product still existing: every OrderItem
// snapshots its name, option, SKU and price, and its productId/variantId
// are set to NULL by the FK when the product goes (migration
// 20261020000000_marketplace_offers_stock). Variations, stock, offers and
// reviews cascade with it. An order still awaiting payment that contains
// it is refunded if the payment lands (see takeStock in orders/service.ts).
export async function deleteProduct(id: string) {
  const product = await prisma.product.findUnique({ where: { id } });
  if (!product) throw ApiError.notFound("Product not found");
  await prisma.product.delete({ where: { id } });
}

// A product with active variations keeps stock per variation — its own
// row isn't used, so adjusting it would only confuse.
export async function adjustStock(productId: string, delta: number) {
  const variantCount = await prisma.productVariant.count({ where: { productId, active: true } });
  if (variantCount > 0) {
    throw ApiError.badRequest("This product has variations — adjust the stock of a specific variation");
  }
  return applyStockDelta({ productId }, delta);
}

// Every stock row at or below its threshold — product-level rows for plain
// products, variant rows (with `variant` populated) for the rest. Skips a
// product-level row the product no longer uses (it has active variations)
// and hidden variations. Filtered in memory: Prisma can't compare two
// columns of a row, and the table is small (one row per sellable item).
export async function listLowStock() {
  const rows = await prisma.stockLevel.findMany({
    include: {
      product: { include: { variants: { where: { active: true }, select: { id: true } } } },
      variant: { include: { product: true } },
    },
  });
  return rows
    .filter((r) => r.quantityOnHand <= r.lowStockThreshold)
    .filter((r) => (r.variant ? r.variant.active : r.product && r.product.variants.length === 0))
    .map(({ product, variant, ...level }) => {
      if (variant) {
        const { product: variantProduct, ...variantFields } = variant;
        return { ...level, product: variantProduct, variant: variantFields };
      }
      const { variants: _variants, ...productFields } = product!;
      return { ...level, product: productFields, variant: null };
    });
}

// --- Stock tab ---------------------------------------------------------------
// One row per sellable item: a plain product, or each variation of a product
// that has them (a product's own row is skipped once it sells per variation).

type StockRow = {
  productId: string;
  productName: string;
  productActive: boolean;
  categoryName: string;
  image: string | null;
  variantId: string | null;
  variantName: string | null;
  variantActive: boolean;
  sku: string;
  stockLevel: StockLevel;
};

export async function listStock(): Promise<StockRow[]> {
  const products = await prisma.product.findMany({
    include: { category: true, stockLevel: true, variants: { orderBy: { sortOrder: "asc" }, include: { stockLevel: true } } },
    orderBy: { name: "asc" },
  });
  return products.flatMap((p): StockRow[] => {
    const base = {
      productId: p.id,
      productName: p.name,
      productActive: p.active,
      categoryName: p.category.name,
      image: p.images[0] ?? null,
    };
    const activeVariants = p.variants.filter((v) => v.active);
    if (p.variants.length === 0 || activeVariants.length === 0) {
      return p.stockLevel
        ? [{ ...base, variantId: null, variantName: null, variantActive: true, sku: p.sku, stockLevel: p.stockLevel }]
        : [];
    }
    return p.variants
      .filter((v) => v.stockLevel)
      .map((v) => ({
        ...base,
        image: v.images[0] ?? base.image,
        variantId: v.id,
        variantName: v.name,
        variantActive: v.active,
        sku: v.sku,
        stockLevel: v.stockLevel!,
      }));
  });
}

// Sets the counted quantity (and/or alert threshold) directly — what a stock
// take needs, rather than working out a +/- delta.
export async function setStockLevel(id: string, data: { quantityOnHand?: number; lowStockThreshold?: number }) {
  const level = await prisma.stockLevel.findUnique({ where: { id } });
  if (!level) throw ApiError.notFound("Stock record not found");
  return prisma.stockLevel.update({ where: { id }, data });
}

// --- Reviews ---------------------------------------------------------------
// Public, unauthenticated, published immediately — no moderation queue yet,
// so spam is removed after the fact via deleteReview (admin).

const MAX_REVIEWS_RETURNED = 100;
const REVIEW_PER_PRODUCT_WINDOW_MS = 24 * 60 * 60 * 1000;

// Never the raw IP. Keyed HMAC so the stored value can't be reversed by
// hashing every IPv4 address.
function hashIp(ip: string) {
  return createHmac("sha256", env.jwtAccessSecret).update(ip).digest("hex");
}

const reviewSelect = {
  id: true,
  productId: true,
  authorName: true,
  rating: true,
  comment: true,
  createdAt: true,
} as const;

async function assertPublicProduct(productId: string) {
  const product = await prisma.product.findFirst({ where: { id: productId, active: true } });
  if (!product) throw ApiError.notFound("Product not found");
}

export async function listReviews(productId: string) {
  await assertPublicProduct(productId);
  return prisma.productReview.findMany({
    where: { productId },
    select: reviewSelect,
    orderBy: { createdAt: "desc" },
    take: MAX_REVIEWS_RETURNED,
  });
}

export async function createReview(
  productId: string,
  input: { authorName?: unknown; rating?: unknown; comment?: unknown },
  ip: string | undefined
) {
  const authorName = typeof input.authorName === "string" ? input.authorName.trim() : "";
  const comment = typeof input.comment === "string" ? input.comment.trim() : "";
  const rating = input.rating;

  if (!authorName) throw ApiError.badRequest("Please enter your name.");
  if (authorName.length > 80) throw ApiError.badRequest("Name must be 80 characters or fewer.");
  if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw ApiError.badRequest("Please choose a rating from 1 to 5 stars.");
  }
  if (!comment) throw ApiError.badRequest("Please write a comment.");
  if (comment.length > 2000) throw ApiError.badRequest("Comment must be 2000 characters or fewer.");

  await assertPublicProduct(productId);

  // The per-IP hourly cap is reviewLimiter (middleware/rateLimit.ts); this
  // is the stricter one-review-per-product-per-day rule, which needs the
  // product id and so can't be a plain route limiter.
  const ipHash = ip ? hashIp(ip) : null;
  if (ipHash) {
    const recent = await prisma.productReview.count({
      where: {
        productId,
        ipHash,
        createdAt: { gt: new Date(Date.now() - REVIEW_PER_PRODUCT_WINDOW_MS) },
      },
    });
    if (recent > 0) {
      throw new ApiError(429, "You've already reviewed this product today — thank you!");
    }
  }

  // Plain text, stored as-is — the frontend renders it as text, never HTML.
  return prisma.productReview.create({
    data: { productId, authorName, rating, comment, ipHash },
    select: reviewSelect,
  });
}

export async function deleteReview(id: string) {
  const review = await prisma.productReview.findUnique({ where: { id } });
  if (!review) throw ApiError.notFound("Review not found");
  await prisma.productReview.delete({ where: { id } });
}
