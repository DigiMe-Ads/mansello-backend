import { prisma } from "@/db/prisma";
import { ApiError } from "@/utils/ApiError";
import { slugify } from "@/utils/slugify";

export function listCategories() {
  return prisma.category.findMany({ orderBy: { name: "asc" } });
}

export async function createCategory(input: { name: string; slug?: string }) {
  if (!input.name?.trim()) throw ApiError.badRequest("name is required");
  const slug = input.slug?.trim() ? slugify(input.slug) : slugify(input.name);
  if (!slug) throw ApiError.badRequest("Could not derive a valid slug from name");

  const existing = await prisma.category.findUnique({ where: { slug } });
  if (existing) throw ApiError.conflict(`A category with slug "${slug}" already exists`);

  return prisma.category.create({ data: { name: input.name.trim(), slug } });
}

// categoryId is required on Product, so a category can't just be deleted out
// from under its products — the FK would reject it anyway, but a pre-check
// gives a clear message instead of a raw constraint error. Delete/reassign
// the products first, then the now-empty category.
export async function deleteCategory(id: string) {
  const category = await prisma.category.findUnique({ where: { id } });
  if (!category) throw ApiError.notFound("Category not found");

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
export function listProducts(categorySlug?: string, includeInactive = false) {
  return prisma.product.findMany({
    where: {
      ...(includeInactive ? {} : { active: true }),
      ...(categorySlug ? { category: { slug: categorySlug } } : {}),
    },
    include: { category: true, stockLevel: true },
    orderBy: { createdAt: "desc" },
  });
}

// Same admin-branch as listProducts, for consistency — an inactive product
// 404s for a public/non-admin caller now instead of being reachable by
// anyone who has (or guesses) its id.
export function getProduct(id: string, includeInactive = false) {
  return prisma.product.findFirst({
    where: { id, ...(includeInactive ? {} : { active: true }) },
    include: { category: true, stockLevel: true },
  });
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
}) {
  return prisma.product.create({
    data: {
      categoryId: input.categoryId,
      name: input.name,
      description: input.description,
      priceUsd: input.priceUsd,
      images: input.images,
      sku: input.sku,
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
  }>
  // Same trust level as createProduct — categoryId isn't pre-validated
  // against Category here either; an unknown id surfaces as the FK
  // constraint rejecting the write, not a clean ApiError. Lets an admin
  // move a product to another category, e.g. to empty one out before
  // deleting it (see deleteCategory above).
) {
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
