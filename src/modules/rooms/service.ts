import { prisma } from "@/db/prisma";
import { ApiError } from "@/utils/ApiError";

export function listRooms(propertyId: string, includeInactive = false) {
  return prisma.room.findMany({
    where: { propertyId, ...(includeInactive ? {} : { active: true }) },
    orderBy: { sortOrder: "asc" },
  });
}

export function getRoom(id: string) {
  return prisma.room.findUnique({ where: { id } });
}

export interface CreateRoomInput {
  name: string;
  subtitle?: string;
  capacity: number;
  pricePerNight: number;
  images?: string[];
  sortOrder?: number;
}

export function createRoom(propertyId: string, input: CreateRoomInput) {
  return prisma.room.create({
    data: {
      propertyId,
      name: input.name,
      subtitle: input.subtitle,
      capacity: input.capacity,
      pricePerNight: input.pricePerNight,
      images: input.images ?? [],
      sortOrder: input.sortOrder ?? 0,
    },
  });
}

export function updateRoom(
  id: string,
  data: Partial<{
    name: string;
    subtitle: string | null;
    capacity: number;
    pricePerNight: number;
    images: string[];
    sortOrder: number;
    active: boolean;
  }>
) {
  return prisma.room.update({ where: { id }, data });
}

// Same "can't delete, has history" guard used elsewhere (Product's
// order-history check, AdminUser's self-delete guard) — a room referenced
// by any non-cancelled booking's roomIds can't be hard-deleted, since that
// booking's per-room AvailabilityBlock rows and historical record still
// depend on it. Deactivate instead (PATCH { active: false }) — already
// keeps it out of the public room list and out of new bookings without
// touching anything that already references it.
export async function deleteRoom(id: string) {
  const room = await prisma.room.findUnique({ where: { id } });
  if (!room) throw ApiError.notFound("Room not found");

  const referencingBooking = await prisma.booking.findFirst({
    where: { roomIds: { has: id }, status: { not: "cancelled" } },
  });
  if (referencingBooking) {
    throw ApiError.conflict(
      "This room has booking history and can't be deleted — deactivate it instead (PATCH active: false)"
    );
  }

  await prisma.room.delete({ where: { id } });
}
