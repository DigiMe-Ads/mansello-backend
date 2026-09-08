import { z } from "zod";

// Accepts either `price` (current — flat band charge, BACKEND_CHANGES_SHIPPING_FLAT_BAND_PRICING.md)
// or the old `pricePerKg` name for one release; service.replaceShippingRates
// normalizes whichever arrives. At least one of the two is required.
export const replaceShippingRatesSchema = z.object({
  body: z.object({
    rates: z.array(
      z
        .object({
          fromKg: z.coerce.number().int().min(0),
          toKg: z.coerce.number().int().min(0),
          price: z.coerce.number().min(0).optional(),
          pricePerKg: z.coerce.number().min(0).optional(),
        })
        .refine((r) => r.price !== undefined || r.pricePerKg !== undefined, {
          message: "price is required",
        })
    ),
  }),
});
