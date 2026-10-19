import { z } from "zod";

// Admin catalog bodies, matching the frontend's Create*/Update*Input types
// (BACKEND_CHANGES_SECURITY_AUDIT_FRONTEND.md M2). Unknown keys are stripped,
// so a body can no longer write arbitrary columns (e.g. a category's slug or
// id) through the service's pass-through updates.

// "" or null clears a category's parent (back to top level), a uuid sets it.
const parentId = z.union([z.string().uuid(), z.literal(""), z.null()]);

export const createCategorySchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(100),
    slug: z.string().trim().max(100).optional(),
    description: z.string().max(1000).nullable().optional(),
    imageUrl: z.string().max(2000).nullable().optional(),
    featured: z.boolean().optional(),
    parentId: parentId.optional(),
  }),
});

export const updateCategorySchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().max(1000).nullable().optional(),
    imageUrl: z.string().max(2000).nullable().optional(),
    featured: z.boolean().optional(),
    // null = move back to top level; absent = unchanged.
    parentId: parentId.optional(),
  }),
});

// One sellable option of a product (BACKEND_CHANGES_VARIANTS_CALENDAR_PAYMENTS_LK.md §1).
const variantFields = {
  name: z.string().trim().min(1).max(80),
  sku: z.string().trim().min(1).max(100),
  priceUsd: z.coerce.number().min(0).max(1_000_000),
  weightKg: z.coerce.number().min(0).max(1000).nullable().optional(),
  initialStock: z.coerce.number().int().min(0).max(1_000_000),
  lowStockThreshold: z.coerce.number().int().min(0).max(1_000_000).optional(),
  images: z.array(z.string().max(2000)).max(10).optional(),
};
const variantBody = z.object(variantFields);

const deliveryDays = z.coerce.number().int().min(0).max(365).nullable().optional();
const deliveryFields = {
  deliveryEstimateEnabled: z.boolean().optional(),
  deliveryMinDays: deliveryDays,
  deliveryMaxDays: deliveryDays,
};

// description is sanitized HTML (see utils/richText.ts) — length-checked
// here, never rejected for containing markup.
const MAX_DESCRIPTION = 10_000;

export const createProductSchema = z.object({
  body: z.object({
    categoryId: z.string().uuid(),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(MAX_DESCRIPTION),
    // Derived from the variations when there are any, so optional then.
    priceUsd: z.coerce.number().min(0).max(1_000_000).optional(),
    images: z.array(z.string().max(2000)).max(20).default([]),
    sku: z.string().trim().min(1).max(100),
    initialStock: z.coerce.number().int().min(0).max(1_000_000).default(0),
    lowStockThreshold: z.coerce.number().int().min(0).max(1_000_000).optional(),
    weightKg: z.coerce.number().min(0).max(1000).nullable().optional(),
    // Present and non-empty = create the product with these variations.
    variants: z.array(variantBody).max(50).optional(),
    ...deliveryFields,
  })
  .refine((b) => (b.variants?.length ?? 0) > 0 || b.priceUsd !== undefined, {
    message: "priceUsd is required for a product without variations",
    path: ["priceUsd"],
  }),
});

export const updateProductSchema = z.object({
  body: z.object({
    categoryId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(MAX_DESCRIPTION).optional(),
    priceUsd: z.coerce.number().min(0).max(1_000_000).optional(),
    images: z.array(z.string().max(2000)).max(20).optional(),
    active: z.boolean().optional(),
    weightKg: z.coerce.number().min(0).max(1000).nullable().optional(),
    ...deliveryFields,
  }),
});

export const stockAdjustmentSchema = z.object({
  body: z.object({
    delta: z.coerce
      .number()
      .int()
      .min(-1_000_000)
      .max(1_000_000)
      .refine((d) => d !== 0, "delta must not be 0"),
  }),
});

export const createVariantSchema = z.object({ body: variantBody });

export const updateVariantSchema = z.object({
  body: z.object({
    name: variantFields.name.optional(),
    sku: variantFields.sku.optional(),
    priceUsd: variantFields.priceUsd.optional(),
    weightKg: variantFields.weightKg,
    active: z.boolean().optional(),
    sortOrder: z.coerce.number().int().min(0).max(10_000).optional(),
    lowStockThreshold: variantFields.lowStockThreshold,
    images: variantFields.images,
  }),
});

export const setStockLevelSchema = z.object({
  body: z
    .object({
      quantityOnHand: z.coerce.number().int().min(0).max(1_000_000).optional(),
      lowStockThreshold: z.coerce.number().int().min(0).max(1_000_000).optional(),
    })
    .refine((b) => b.quantityOnHand !== undefined || b.lowStockThreshold !== undefined, "Nothing to change"),
});

// Offers take full timestamps — the admin picks local date/times and the
// browser sends them as ISO strings.
const offerFields = {
  variantId: z.union([z.string().uuid(), z.literal(""), z.null()]).optional(),
  title: z.string().trim().max(80).nullable().optional(),
  discountPercent: z.coerce.number().int().min(1).max(90),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  active: z.boolean().optional(),
};

export const createOfferSchema = z.object({ body: z.object(offerFields) });

export const updateOfferSchema = z.object({
  body: z.object({
    variantId: offerFields.variantId,
    title: offerFields.title,
    discountPercent: offerFields.discountPercent.optional(),
    startsAt: offerFields.startsAt.optional(),
    endsAt: offerFields.endsAt.optional(),
    active: offerFields.active,
  }),
});
