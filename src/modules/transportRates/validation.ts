import { z } from "zod";

export const replaceTransportRatesSchema = z.object({
  body: z.object({
    rates: z.array(
      z.object({
        guestCount: z.coerce.number().int().min(1).max(8),
        price: z.coerce.number().min(0),
        active: z.boolean().optional(),
      })
    ),
  }),
});
