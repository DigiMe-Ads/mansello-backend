import { prisma } from "@/db/prisma";

export function listTransportRates(propertyId: string) {
  return prisma.transportRate.findMany({ where: { propertyId }, orderBy: { guestCount: "asc" } });
}

// Replaces the whole per-property table in one call — the admin form always
// saves all eight rows (guestCount 1–8) together. Upsert on
// (propertyId, guestCount) rather than delete-all-then-recreate (unlike
// ShippingRate) since this table DOES have a natural stable identity per
// row, and a booking's own historical pricing never references a
// TransportRate row directly (it snapshots the price onto Booking.transportPrice),
// so there's no FK to worry about either way. See BACKEND_CHANGES_VILLA_TRANSPORT.md.
export async function replaceTransportRates(
  propertyId: string,
  rates: { guestCount: number; price: number; active?: boolean }[]
) {
  await prisma.$transaction(
    rates.map((r) =>
      prisma.transportRate.upsert({
        where: { propertyId_guestCount: { propertyId, guestCount: r.guestCount } },
        update: { price: r.price, active: r.active ?? false },
        create: { propertyId, guestCount: r.guestCount, price: r.price, active: r.active ?? false },
      })
    )
  );
  return listTransportRates(propertyId);
}
