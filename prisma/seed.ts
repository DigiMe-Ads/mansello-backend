import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function upsertPricingTier(
  propertyId: string,
  guestCount: number,
  rooms: number,
  pricePerNight: number
) {
  await prisma.pricingTier.upsert({
    where: { propertyId_guestCount_rooms: { propertyId, guestCount, rooms } },
    update: { pricePerNight },
    create: { propertyId, guestCount, rooms, pricePerNight },
  });
}

// Comune di Bologna, 2026 rates — imposta di soggiorno, banded by the
// room's price per person per night. See BACKEND_CHANGES_CITY_TAX.md.
const bolognaCityTaxBands = [
  { minPricePerPersonPerNight: 1, maxPricePerPersonPerNight: 30.99, ratePerPersonPerNight: 4.0 },
  { minPricePerPersonPerNight: 31, maxPricePerPersonPerNight: 70.99, ratePerPersonPerNight: 5.8 },
  { minPricePerPersonPerNight: 71, maxPricePerPersonPerNight: 120.99, ratePerPersonPerNight: 6.5 },
  { minPricePerPersonPerNight: 121, maxPricePerPersonPerNight: null, ratePerPersonPerNight: 7.0 },
];

async function main() {
  const bolognaCityTax = {
    cityTaxEnabled: true,
    cityTaxMaxNights: 5,
    cityTaxExemptAgeUnder: 14,
    cityTaxBands: bolognaCityTaxBands,
  };

  const bologna = await prisma.property.upsert({
    where: { slug: "the-nest-bologna" },
    update: { currency: "eur", ...bolognaCityTax },
    create: {
      slug: "the-nest-bologna",
      name: "The Nest Bologna",
      country: "Italy",
      currency: "eur",
      timezone: "Europe/Rome",
      checkInTime: "15:00",
      checkOutTime: "11:00",
      minNights: 1,
      turnoverBufferDays: 0,
      maxGuests: 4,
      address: "Bologna, Italy",
      stripeAccountRef: "italy",
      airbnbIcalImportUrls: [
        "https://www.airbnb.com/calendar/ical/1695778052767952475.ics?t=f7766ba85b034110a3eb73acd779bfb0&locale=en-GB",
      ],
      ...bolognaCityTax,
    },
  });

  // Single-unit villa — one price per guest count, always 1 "room" (the whole place).
  await upsertPricingTier(bologna.id, 1, 1, 85);
  await upsertPricingTier(bologna.id, 2, 1, 90);
  await upsertPricingTier(bologna.id, 3, 1, 110);
  await upsertPricingTier(bologna.id, 4, 1, 135);

  const donasVilla = await prisma.property.upsert({
    where: { slug: "donas-villa" },
    update: { maxGuests: 6 }, // matches the ceiling of the client's pricing grid
    create: {
      slug: "donas-villa",
      name: "Dona's Villa",
      country: "Sri Lanka",
      currency: "usd",
      timezone: "Asia/Colombo",
      checkInTime: "14:00",
      checkOutTime: "11:00",
      minNights: 1,
      turnoverBufferDays: 0,
      maxGuests: 6,
      address: "Sri Lanka",
      stripeAccountRef: "sri_lanka",
      airbnbIcalImportUrls: [
        "https://www.airbnb.com/calendar/ical/1495536150084118629.ics?t=a351a1490a2d45988a9e3515f8aeb433&locale=en-GB",
        "https://www.airbnb.com/calendar/ical/1615969265898945760.ics?t=45e959c06be24e4dbcf8510736d57dd8&locale=en-GB",
        "https://www.airbnb.com/calendar/ical/1615992081278869970.ics?t=ff8af245e5f34621b52d414a8f65768c&locale=en-GB",
        "https://www.airbnb.com/calendar/ical/1187687130177684227.ics?t=569f34219f28418f9d538817379c18e1&locale=en-GB",
      ],
    },
  });

  // Multi-room villa — price depends on both guest count and how many rooms
  // the guest chooses, per the client's pricing grid.
  await upsertPricingTier(donasVilla.id, 1, 1, 18);
  await upsertPricingTier(donasVilla.id, 2, 1, 18);
  await upsertPricingTier(donasVilla.id, 2, 2, 30);
  await upsertPricingTier(donasVilla.id, 3, 1, 24);
  await upsertPricingTier(donasVilla.id, 3, 2, 30);
  await upsertPricingTier(donasVilla.id, 4, 1, 27);
  await upsertPricingTier(donasVilla.id, 4, 2, 30);
  await upsertPricingTier(donasVilla.id, 5, 2, 40);
  await upsertPricingTier(donasVilla.id, 5, 3, 48);
  await upsertPricingTier(donasVilla.id, 6, 2, 40);
  await upsertPricingTier(donasVilla.id, 6, 3, 50);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
