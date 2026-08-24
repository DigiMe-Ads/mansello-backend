import { z } from "zod";

export const createOfferSchema = z.object({
  body: z.object({
    propertyId: z.string().uuid(),
    title: z.string().min(1),
    discountPercent: z.coerce.number().int().min(0).max(100),
    imageUrl: z.string().url().optional(),
    active: z.boolean().optional(),
    // Both optional — omitting either means "no date limit" (applies
    // whenever active: true, same as before this field existed).
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
  }),
});

export const updateOfferSchema = z.object({
  body: z.object({
    title: z.string().min(1).optional(),
    discountPercent: z.coerce.number().int().min(0).max(100).optional(),
    imageUrl: z.string().url().nullable().optional(),
    active: z.boolean().optional(),
    startDate: z.coerce.date().nullable().optional(),
    endDate: z.coerce.date().nullable().optional(),
  }),
});
