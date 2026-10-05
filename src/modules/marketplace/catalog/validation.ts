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

// description is sanitized HTML (see utils/richText.ts) — length-checked
// here, never rejected for containing markup.
const MAX_DESCRIPTION = 10_000;

export const createProductSchema = z.object({
  body: z.object({
    categoryId: z.string().uuid(),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(MAX_DESCRIPTION),
    priceUsd: z.coerce.number().min(0).max(1_000_000),
    images: z.array(z.string().max(2000)).max(20).default([]),
    sku: z.string().trim().min(1).max(100),
    initialStock: z.coerce.number().int().min(0).max(1_000_000),
    lowStockThreshold: z.coerce.number().int().min(0).max(1_000_000).optional(),
    weightKg: z.coerce.number().min(0).max(1000).nullable().optional(),
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
