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
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(254),
    itemDescription: z.string().trim().min(1).max(5000),
    notes: z.string().trim().max(2000).optional(),
  }),
});

// Public forms — bodies exactly as the frontend sends them
// (BACKEND_CHANGES_SECURITY_AUDIT_FRONTEND.md M2). Unknown keys are stripped,
// so a caller can no longer set status/id/createdAt on the stored row.
export const createContactMessageSchema = z.object({
  body: z.object({
    site: z.enum(["italy", "sri_lanka"]),
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(254),
    subject: z.enum(["room_booking", "airport_transfer", "tour_package", "marketplace", "other"]),
    message: z.string().trim().min(1).max(5000),
  }),
});

export const createTransportRequestSchema = z.object({
  body: z.object({
    propertyId: z.string().uuid().optional(),
    // Only ever sent by the booking flow, for the booking it just created —
    // verified against that booking in the service.
    bookingId: z.string().uuid().optional(),
    type: z.enum(["fixed_price", "custom_quote"]),
    date: z.coerce.date(),
    flightNumber: z.string().trim().max(40).optional(),
    passengers: z.coerce.number().int().min(1).max(50),
    contactName: z.string().trim().min(1).max(120),
    contactEmail: z.string().trim().email().max(254),
    contactPhone: z.string().trim().min(3).max(40),
    notes: z.string().trim().max(2000).optional(),
  }),
});

export const updateLeadStatusSchema = z.object({
  body: z.object({ status: z.enum(["new", "read", "responded"]) }),
});
