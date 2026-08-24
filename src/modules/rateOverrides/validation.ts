import { z } from "zod";

// Exactly one of roomId or (guestCount, rooms) — cross-field check below,
// since zod's per-field schema can't express "exactly one of" on its own.
const targetFields = {
  roomId: z.string().uuid().optional(),
  guestCount: z.coerce.number().int().min(1).optional(),
  rooms: z.coerce.number().int().min(1).optional(),
};

function hasExactlyOneTarget(body: { roomId?: string; guestCount?: number; rooms?: number }) {
  const hasRoom = body.roomId !== undefined;
  const hasTier = body.guestCount !== undefined || body.rooms !== undefined;
  // Both guestCount and rooms must be present together for the tier form.
  if (hasTier && (body.guestCount === undefined || body.rooms === undefined)) return false;
  return hasRoom !== hasTier;
}

export const createRateOverrideSchema = z.object({
  body: z
    .object({
      ...targetFields,
      startDate: z.coerce.date(),
      endDate: z.coerce.date(),
      pricePerNight: z.coerce.number().min(0),
    })
    .refine(hasExactlyOneTarget, {
      message: "Exactly one of roomId or (guestCount and rooms) must be set",
    }),
});

export const updateRateOverrideSchema = z.object({
  body: z.object({
    roomId: z.string().uuid().optional(),
    guestCount: z.coerce.number().int().min(1).optional(),
    rooms: z.coerce.number().int().min(1).optional(),
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
    pricePerNight: z.coerce.number().min(0).optional(),
  }),
  // Not refined here — a PATCH can touch only pricePerNight/dates without
  // re-specifying the target at all; the service validates the merged
  // (existing + patch) result instead, which a body-only schema can't see.
});
