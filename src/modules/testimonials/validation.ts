import { z } from "zod";

const siteEnum = z.enum(["italy", "sri_lanka"]);

export const createTestimonialSchema = z.object({
  body: z.object({
    site: siteEnum,
    name: z.string().min(1),
    role: z.string().min(1),
    quote: z.string().min(1),
    rating: z.coerce.number().int().min(1).max(5),
    sortOrder: z.coerce.number().int().optional(),
    active: z.boolean().optional(),
  }),
});

export const updateTestimonialSchema = z.object({
  body: z.object({
    name: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
    quote: z.string().min(1).optional(),
    rating: z.coerce.number().int().min(1).max(5).optional(),
    sortOrder: z.coerce.number().int().optional(),
    active: z.boolean().optional(),
  }),
});
