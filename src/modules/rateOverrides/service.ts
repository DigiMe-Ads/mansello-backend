import { prisma } from "@/db/prisma";
import { ApiError } from "@/utils/ApiError";

export function listRateOverrides(propertyId: string) {
  return prisma.rateOverride.findMany({ where: { propertyId }, orderBy: { startDate: "asc" } });
}

export function getRateOverride(id: string) {
  return prisma.rateOverride.findUnique({ where: { id } });
}

export interface RateOverrideTarget {
  roomId?: string | null;
  guestCount?: number | null;
  rooms?: number | null;
}

// Exactly one of roomId or (guestCount, rooms) — matching whichever pricing
// model the property actually uses — plus that it actually resolves to
// something real on this property: a roomId that belongs to it, or a
// (guestCount, rooms) pair with an existing PricingTier. Re-run against the
// merged (existing + patch) state on update, not just on create, so a PATCH
// can't leave a row in an inconsistent state either.
async function validateRateOverrideTarget(propertyId: string, target: RateOverrideTarget) {
  const hasRoom = target.roomId != null;
  const hasTier = target.guestCount != null && target.rooms != null;
  if (hasRoom === hasTier) {
    throw ApiError.badRequest("Exactly one of roomId or (guestCount and rooms) must be set");
  }

  if (hasRoom) {
    const room = await prisma.room.findUnique({ where: { id: target.roomId! } });
    if (!room || room.propertyId !== propertyId) {
      throw ApiError.badRequest("roomId must belong to this property");
    }
  } else {
    const tier = await prisma.pricingTier.findUnique({
      where: { propertyId_guestCount_rooms: { propertyId, guestCount: target.guestCount!, rooms: target.rooms! } },
    });
    if (!tier) {
      throw ApiError.badRequest("No PricingTier exists for that guestCount/rooms combination on this property");
    }
  }
}

export interface CreateRateOverrideInput {
  roomId?: string;
  guestCount?: number;
  rooms?: number;
  startDate: Date;
  endDate: Date;
  pricePerNight: number;
}

export async function createRateOverride(propertyId: string, input: CreateRateOverrideInput) {
  await validateRateOverrideTarget(propertyId, input);
  return prisma.rateOverride.create({
    data: {
      propertyId,
      roomId: input.roomId,
      guestCount: input.guestCount,
      rooms: input.rooms,
      startDate: input.startDate,
      endDate: input.endDate,
      pricePerNight: input.pricePerNight,
    },
  });
}

export async function updateRateOverride(
  id: string,
  data: Partial<{
    roomId: string | null;
    guestCount: number | null;
    rooms: number | null;
    startDate: Date;
    endDate: Date;
    pricePerNight: number;
  }>
) {
  const existing = await prisma.rateOverride.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound("Rate override not found");

  const merged: RateOverrideTarget = {
    roomId: data.roomId !== undefined ? data.roomId : existing.roomId,
    guestCount: data.guestCount !== undefined ? data.guestCount : existing.guestCount,
    rooms: data.rooms !== undefined ? data.rooms : existing.rooms,
  };
  await validateRateOverrideTarget(existing.propertyId, merged);

  return prisma.rateOverride.update({ where: { id }, data });
}

// Hard delete — no history concern here (unlike rooms/products), an
// override is just a price rule, not something referenced by past bookings.
export async function deleteRateOverride(id: string) {
  const existing = await prisma.rateOverride.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound("Rate override not found");
  await prisma.rateOverride.delete({ where: { id } });
}
