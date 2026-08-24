import { prisma } from "@/db/prisma";
import { ApiError } from "@/utils/ApiError";

export function listBlocksForProperty(propertyId: string, from?: string, to?: string) {
  return prisma.availabilityBlock.findMany({
    where: {
      propertyId,
      status: "active",
      ...(from && to ? { startDate: { lt: new Date(to) }, endDate: { gt: new Date(from) } } : {}),
    },
    orderBy: { startDate: "asc" },
  });
}

// Whole-villa locking (BACKEND_CHANGES_PRICING_DISCOUNTS_SHIPPING.md §3,
// supersedes the independent-per-room-availability design
// BACKEND_CHANGES_SRI_LANKA_ROOMS.md originally shipped): only one party
// occupies the property at a time, so this deliberately ignores roomId —
// ANY active block for the property overlapping the range makes it
// unavailable, room-specific or not. Runs the same check the DB exclusion
// constraints enforce, so the API can return a friendly 409 before even
// attempting the insert. The constraints themselves (SUPABASE_SETUP.md) are
// the real source of truth under concurrency for two DIFFERENT bookings
// conflicting; the one case they can't express — a booking's block(s)
// vs. an existing bookingId-less (manual/Airbnb) block — is only checked
// here, which is why this function is also called inline inside the
// booking transaction, not just from the manual-block endpoint.
export async function isRangeFree(propertyId: string, startDate: Date, endDate: Date) {
  const overlapping = await prisma.availabilityBlock.findFirst({
    where: {
      propertyId,
      status: "active",
      startDate: { lt: endDate },
      endDate: { gt: startDate },
    },
  });
  return !overlapping;
}

export async function createManualBlock(input: {
  propertyId: string;
  startDate: Date;
  endDate: Date;
  reason?: string;
  // Still accepted and stored (which specific room a maintenance block is
  // "for", shown in the admin Blocks tab) but no longer consulted for the
  // availability check itself — any block, room-specific or not, now locks
  // the whole property. Omit for the same whole-property block this always
  // created.
  roomId?: string;
}) {
  if (!(await isRangeFree(input.propertyId, input.startDate, input.endDate))) {
    throw ApiError.conflict("Dates overlap an existing block or booking");
  }
  return prisma.availabilityBlock.create({
    data: {
      propertyId: input.propertyId,
      startDate: input.startDate,
      endDate: input.endDate,
      source: "manual",
      status: "active",
      roomId: input.roomId,
    },
  });
}

export function releaseBlock(blockId: string) {
  return prisma.availabilityBlock.update({ where: { id: blockId }, data: { status: "cancelled" } });
}
