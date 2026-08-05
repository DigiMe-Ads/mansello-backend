import { z } from "zod";

export const subscribeNewsletterSchema = z.object({
  body: z.object({
    email: z.string().email(),
    site: z.enum(["italy", "sri_lanka"]),
  }),
});
