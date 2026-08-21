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

// Runs the same check the DB exclusion constraints enforce, so the API can
// return a friendly 409 before even attempting the insert. The constraints
// themselves (see SUPABASE_SETUP.md) are the real source of truth under
// concurrency for same-room and same-whole-property overlaps; the one case
// they can't express — a whole-property block vs. a room-specific one — is
// only checked here (see that doc section for why), which is why this
// function is also called inline inside the booking transaction for a
// room-booking, not just from the manual-block endpoint.
//
// roomId omitted/undefined = checking a whole-property block: conflicts
// with ANY active block for the property, room-specific or not, since a
// whole-property block blocks every room. roomId given = checking one
// room: conflicts with a block on that same room, or a whole-property
// block (roomId IS NULL blocks every room), but not a different room.
export async function isRangeFree(
  propertyId: string,
  startDate: Date,
  endDate: Date,
  roomId?: string
) {
  const overlapping = await prisma.availabilityBlock.findFirst({
    where: {
      propertyId,
      status: "active",
      startDate: { lt: endDate },
      endDate: { gt: startDate },
      ...(roomId ? { OR: [{ roomId: null }, { roomId }] } : {}),
    },
  });
  return !overlapping;
}

export async function createManualBlock(input: {
  propertyId: string;
  startDate: Date;
  endDate: Date;
  reason?: string;
  roomId?: string; // omit for today's whole-property behavior, unchanged
}) {
  if (!(await isRangeFree(input.propertyId, input.startDate, input.endDate, input.roomId))) {
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
