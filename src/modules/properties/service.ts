import { prisma } from "@/db/prisma";
import { ApiError } from "@/utils/ApiError";

export function listProperties() {
  return prisma.property.findMany({ include: { pricingTiers: true } });
}

// Includes active rooms, all rateOverrides, and transportRates alongside
// pricingTiers, so the public site gets them for free with no extra
// request — empty arrays for a property with none, same no-op-by-default
// shape as every other room/pricing addition. transportEnabled is a plain
// scalar column, always present with no `include` needed.
export function getPropertyBySlug(slug: string) {
  return prisma.property.findUnique({
    where: { slug },
    include: {
      pricingTiers: true,
      rooms: { where: { active: true }, orderBy: { sortOrder: "asc" } },
      rateOverrides: true,
      transportRates: { orderBy: { guestCount: "asc" } },
    },
  });
}

export function getPropertyById(id: string) {
  return prisma.property.findUnique({
    where: { id },
    include: { pricingTiers: true, transportRates: { orderBy: { guestCount: "asc" } } },
  });
}

export function updatePricingTiers(
  propertyId: string,
  tiers: { guestCount: number; rooms?: number; pricePerNight: number }[]
) {
  return prisma.$transaction(
    tiers.map((tier) => {
      const rooms = tier.rooms ?? 1;
      return prisma.pricingTier.upsert({
        where: { propertyId_guestCount_rooms: { propertyId, guestCount: tier.guestCount, rooms } },
        update: { pricePerNight: tier.pricePerNight },
        create: { propertyId, guestCount: tier.guestCount, rooms, pricePerNight: tier.pricePerNight },
      });
    })
  );
}

// Scoped to propertyId so a villa_manager can't delete another property's
// tier just by guessing/reusing a tierId — requirePropertyScope only checks
// the :propertyId route param matches their scope, not that the tier itself
// belongs to it.
export async function deletePricingTier(propertyId: string, tierId: string) {
  const tier = await prisma.pricingTier.findUnique({ where: { id: tierId } });
  if (!tier || tier.propertyId !== propertyId) throw ApiError.notFound("Pricing tier not found");
  await prisma.pricingTier.delete({ where: { id: tierId } });
}

export function updateProperty(
  id: string,
  data: Partial<{
    minNights: number;
    turnoverBufferDays: number;
    checkInTime: string;
    checkOutTime: string;
    airbnbIcalImportUrls: string[];
    transportEnabled: boolean;
    maxGuests: number;
    // See BACKEND_CHANGES_ICAL_MINUS_ONE_DAY.md — deliberately toggleable
    // with no deploy, since two properties can reasonably want different
    // answers, and it should only ever be flipped after confirming a
    // specific listing's own feed actually pads its checkout day.
    icalCheckoutDayBuffer: boolean;
  }>
) {
  return prisma.property.update({ where: { id }, data });
}
