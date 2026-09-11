import { z } from "zod";

export const subscribeNewsletterSchema = z.object({
  body: z.object({
    email: z.string().email(),
    site: z.enum(["italy", "sri_lanka"]),
  }),
});

export const createCustomOrderRequestSchema = z.object({
  body: z.object({
    site: z.enum(["italy", "sri_lanka"]).optional(),
    name: z.string().min(1),
    email: z.string().email(),
    itemDescription: z.string().min(1),
    notes: z.string().optional(),
  }),
});
