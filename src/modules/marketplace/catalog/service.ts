import { createHmac } from "crypto";
import { prisma } from "@/db/prisma";
import { env } from "@/config/env";
import { ApiError } from "@/utils/ApiError";
import { slugify } from "@/utils/slugify";
import { hasVisibleText, sanitizeDescription } from "@/utils/richText";

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
    include: { category: true, stockLevel: true },
    orderBy: { createdAt: "desc" },
  });
  return withRatings(products);
}

// Same admin-branch as listProducts, for consistency — an inactive product
// 404s for a public/non-admin caller now instead of being reachable by
// anyone who has (or guesses) its id.
export async function getProduct(id: string, includeInactive = false) {
  const product = await prisma.product.findFirst({
    where: { id, ...(includeInactive ? {} : { active: true }) },
    include: { category: true, stockLevel: true },
  });
  if (!product) return null;
  const [withRating] = await withRatings([product]);
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

export function createProduct(input: {
  categoryId: string;
  name: string;
  description: string;
  priceUsd: number;
  images: string[];
  sku: string;
  initialStock: number;
  lowStockThreshold?: number;
  weightKg?: number | null;
}) {
  return prisma.product.create({
    data: {
      categoryId: input.categoryId,
      name: input.name,
      description: cleanDescription(input.description),
      priceUsd: input.priceUsd,
      images: input.images,
      sku: input.sku,
      weightKg: input.weightKg,
      stockLevel: {
        create: {
          quantityOnHand: input.initialStock,
          lowStockThreshold: input.lowStockThreshold ?? 5,
        },
      },
    },
    include: { stockLevel: true },
  });
}

export function updateProduct(
  id: string,
  data: Partial<{
    categoryId: string;
    name: string;
    description: string;
    priceUsd: number;
    images: string[];
    active: boolean;
    weightKg: number | null;
  }>
  // Same trust level as createProduct — categoryId isn't pre-validated
  // against Category here either; an unknown id surfaces as the FK
  // constraint rejecting the write, not a clean ApiError. Lets an admin
  // move a product to another category, e.g. to empty one out before
  // deleting it (see deleteCategory above).
) {
  if (data.description !== undefined) data.description = cleanDescription(data.description);
  return prisma.product.update({ where: { id }, data });
}

// A product that's actually been ordered keeps its row referenced by
// OrderItem (which snapshots name/price at time of purchase, so historical
// orders don't depend on the product still existing) — hard-deleting it
// would break that FK for no good reason. Deactivating (already-supported
// via PATCH { active: false }) is the right move there instead; a genuine
// leftover-test product with no order history deletes cleanly, and its
// StockLevel row cascades with it.
export async function deleteProduct(id: string) {
  const product = await prisma.product.findUnique({ where: { id } });
  if (!product) throw ApiError.notFound("Product not found");

  const orderItemCount = await prisma.orderItem.count({ where: { productId: id } });
  if (orderItemCount > 0) {
    throw ApiError.conflict(
      "This product has order history and can't be deleted — deactivate it instead (PATCH active: false)"
    );
  }

  await prisma.product.delete({ where: { id } });
}

export function adjustStock(productId: string, delta: number) {
  return prisma.stockLevel.update({
    where: { productId },
    data: { quantityOnHand: { increment: delta } },
  });
}

// Prisma can't compare two columns of the same row in a `where`, so this is
// a raw query rather than the usual findMany.
export function listLowStock() {
  return prisma.$queryRaw`
    SELECT s.*, row_to_json(p.*) as product
    FROM "StockLevel" s
    JOIN "Product" p ON p.id = s."productId"
    WHERE s."quantityOnHand" <= s."lowStockThreshold"
  `;
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
