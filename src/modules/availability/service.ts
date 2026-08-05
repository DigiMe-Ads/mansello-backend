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

// Runs the same check the DB exclusion constraint enforces, so the API can
// return a friendly 409 before even attempting the insert. The constraint
// itself (see SUPABASE_SETUP.md) is the real source of truth under concurrency.
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
    },
  });
}

export function releaseBlock(blockId: string) {
  return prisma.availabilityBlock.update({ where: { id: blockId }, data: { status: "cancelled" } });
}
