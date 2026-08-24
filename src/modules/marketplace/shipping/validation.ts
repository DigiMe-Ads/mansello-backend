import { z } from "zod";

export const replaceShippingRatesSchema = z.object({
  body: z.object({
    rates: z.array(
      z.object({
        fromKg: z.coerce.number().int().min(0),
        toKg: z.coerce.number().int().min(0),
        pricePerKg: z.coerce.number().min(0),
      })
    ),
  }),
});
