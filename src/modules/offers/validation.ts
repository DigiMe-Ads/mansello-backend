import { z } from "zod";

export const createOfferSchema = z.object({
  body: z.object({
    propertyId: z.string().uuid(),
    title: z.string().min(1),
    discountPercent: z.coerce.number().int().min(0).max(100),
    imageUrl: z.string().url().optional(),
    active: z.boolean().optional(),
  }),
});

export const updateOfferSchema = z.object({
  body: z.object({
    title: z.string().min(1).optional(),
    discountPercent: z.coerce.number().int().min(0).max(100).optional(),
    imageUrl: z.string().url().nullable().optional(),
    active: z.boolean().optional(),
  }),
});
