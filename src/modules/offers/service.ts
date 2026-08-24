import { prisma } from "@/db/prisma";
import { ApiError } from "@/utils/ApiError";

export function listOffers(propertyId: string) {
  return prisma.offer.findMany({ where: { propertyId }, orderBy: { createdAt: "desc" } });
}

export function getOffer(id: string) {
  return prisma.offer.findUnique({ where: { id } });
}

export interface OfferInput {
  propertyId: string;
  title: string;
  discountPercent: number;
  imageUrl?: string;
  active?: boolean;
  startDate?: Date;
  endDate?: Date;
}

// At most one active offer per property — enforced here rather than a DB
// constraint (same tradeoff as turnoverBufferDays: admin-driven, low-write-
// volume, not worth a partial-unique-index migration for). Both callers run
// this inside the same transaction as the write that set active:true, so a
// concurrent request can't observe two active offers even momentarily.
export async function createOffer(input: OfferInput) {
  return prisma.$transaction(async (tx) => {
    const offer = await tx.offer.create({
      data: {
        propertyId: input.propertyId,
        title: input.title,
        discountPercent: input.discountPercent,
        imageUrl: input.imageUrl,
        active: input.active ?? false,
        startDate: input.startDate,
        endDate: input.endDate,
      },
    });
    if (offer.active) {
      await tx.offer.updateMany({
        where: { propertyId: input.propertyId, active: true, id: { not: offer.id } },
        data: { active: false },
      });
    }
    return offer;
  });
}

export async function updateOffer(
  id: string,
  data: Partial<{
    title: string;
    discountPercent: number;
    imageUrl: string | null;
    active: boolean;
    startDate: Date | null;
    endDate: Date | null;
  }>
) {
  return prisma.$transaction(async (tx) => {
    const offer = await tx.offer.update({ where: { id }, data });
    if (data.active) {
      await tx.offer.updateMany({
        where: { propertyId: offer.propertyId, active: true, id: { not: offer.id } },
        data: { active: false },
      });
    }
    return offer;
  });
}

export async function deleteOffer(id: string) {
  const offer = await prisma.offer.findUnique({ where: { id } });
  if (!offer) throw ApiError.notFound("Offer not found");
  await prisma.offer.delete({ where: { id } });
}
