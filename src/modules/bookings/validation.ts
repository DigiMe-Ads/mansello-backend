import { z } from "zod";

const bookingBody = z.object({
  propertyId: z.string().uuid(),
  guestName: z.string().min(1),
  guestEmail: z.string().email(),
  guestPhone: z.string().min(1),
  guestIdDocumentType: z.string().optional(),
  guestIdDocumentNumber: z.string().optional(),
  checkIn: z.coerce.date(),
  checkOut: z.coerce.date(),
  guests: z.coerce.number().int().min(1),
  rooms: z.coerce.number().int().min(1).optional(),
});

export const startBookingSchema = z.object({ body: bookingBody });

export const offlineBookingSchema = z.object({
  body: bookingBody.extend({ totalPriceOverride: z.coerce.number().min(0).optional() }),
});

export const cancelBookingSchema = z.object({
  body: z.object({
    refundOverride: z.coerce.number().min(0).optional(),
    reason: z.string().optional(),
  }),
});
