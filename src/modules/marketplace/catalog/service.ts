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

export function listProducts(categorySlug?: string) {
  return prisma.product.findMany({
    where: {
      active: true,
      ...(categorySlug ? { category: { slug: categorySlug } } : {}),
    },
    include: { category: true, stockLevel: true },
    orderBy: { createdAt: "desc" },
  });
}

export function getProduct(id: string) {
  return prisma.product.findUnique({ where: { id }, include: { category: true, stockLevel: true } });
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
  data: Partial<{ name: string; description: string; priceUsd: number; images: string[]; active: boolean }>
) {
  return prisma.product.update({ where: { id }, data });
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
