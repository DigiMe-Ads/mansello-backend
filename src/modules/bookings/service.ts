import { Prisma } from "@prisma/client";
import { prisma } from "@/db/prisma";
import { env } from "@/config/env";
import { ApiError } from "@/utils/ApiError";

function isExclusionViolation(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // P2010 = raw query failed; message carries the underlying Postgres error.
    return err.message.includes("23P01") || err.message.toLowerCase().includes("exclusion");
  }
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    return err.message.includes("23P01") || err.message.toLowerCase().includes("exclusion");
  }
  return false;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Property.cityTaxBands shape — the Bologna municipal tourist tax (imposta
// di soggiorno), banded by the room's underlying price per person per
// night (not what any one guest is actually charged, which can differ once
// discounts etc. exist). `maxPricePerPersonPerNight: null` marks the top,
// unbounded band.
export interface CityTaxBand {
  minPricePerPersonPerNight: number;
  maxPricePerPersonPerNight: number | null;
  ratePerPersonPerNight: number;
}

// Guests under cityTaxExemptAgeUnder pay nothing. Computed per night now
// (BACKEND_CHANGES_PRICING_DISCOUNTS_SHIPPING.md §1) since a RateOverride
// can make the underlying rate vary night to night — the caller sums this
// across nights and stops calling it once cityTaxMaxNights of the stay have
// been taxed (the room price itself is unaffected by that cap, only the tax
// stops). `nightPrice` is the resolved, post-RateOverride, pre-discount
// price for that one night — tax bands off the underlying rate, not what
// the guest actually ends up charged after a promotional discount, same
// reasoning already applied to totalPriceOverride in createOfflineBooking
// below.
function computeCityTaxForNight(
  property: { cityTaxEnabled: boolean; cityTaxExemptAgeUnder: number; cityTaxBands: unknown },
  nightPrice: number,
  guests: number,
  childrenUnder14: number
): number {
  if (!property.cityTaxEnabled) return 0;

  const taxableGuests = Math.max(0, guests - Math.min(childrenUnder14, guests));
  const pricePerPersonPerNight = nightPrice / guests;

  const bands = property.cityTaxBands as CityTaxBand[];
  const band = bands.find(
    (b) =>
      pricePerPersonPerNight >= b.minPricePerPersonPerNight &&
      (b.maxPricePerPersonPerNight === null || pricePerPersonPerNight <= b.maxPricePerPersonPerNight)
  );

  return band ? taxableGuests * band.ratePerPersonPerNight : 0;
}

function nightlyDates(checkIn: Date, nights: number): Date[] {
  const dates: Date[] = [];
  for (let i = 0; i < nights; i++) dates.push(new Date(checkIn.getTime() + i * MS_PER_DAY));
  return dates;
}

// RateOverride.endDate is inclusive (admin picks a range like a normal date
// field), unlike AvailabilityBlock's half-open [start, end) convention.
function coversDate(start: Date, end: Date, date: Date): boolean {
  return start.getTime() <= date.getTime() && date.getTime() <= end.getTime();
}

type RateOverrideRow = Awaited<ReturnType<typeof prisma.rateOverride.findMany>>[number];

function resolveRoomNightlyPrice(room: { id: string; pricePerNight: Prisma.Decimal }, overrides: RateOverrideRow[], date: Date): number {
  const match = overrides.find((o) => o.roomId === room.id && coversDate(o.startDate, o.endDate, date));
  return match ? Number(match.pricePerNight) : Number(room.pricePerNight);
}

function resolveTierNightlyPrice(
  guestCount: number,
  rooms: number,
  basePricePerNight: number,
  overrides: RateOverrideRow[],
  date: Date
): number {
  const match = overrides.find(
    (o) => o.guestCount === guestCount && o.rooms === rooms && coversDate(o.startDate, o.endDate, date)
  );
  return match ? Number(match.pricePerNight) : basePricePerNight;
}

// Highest matching active offer's % for this one night — offers don't
// stack (BACKEND_CHANGES_PRICING_DISCOUNTS_SHIPPING.md §2). An offer with
// no date range (or only one of startDate/endDate set — shouldn't happen
// given they're set/cleared together, but treated the same defensively as
// "no limit" rather than never matching) covers every night.
function resolveNightlyDiscountPercent(
  offers: { discountPercent: number; startDate: Date | null; endDate: Date | null }[],
  date: Date
): number {
  let highest = 0;
  for (const offer of offers) {
    const covers = !offer.startDate || !offer.endDate ? true : coversDate(offer.startDate, offer.endDate, date);
    if (covers && offer.discountPercent > highest) highest = offer.discountPercent;
  }
  return highest;
}

// The price a guest pays is never taken from the request. For a property
// with zero rooms configured (The Nest Bologna), it's looked up from
// PricingTier (guestCount x rooms) exactly as before — every room-related
// branch below no-ops for that property. For a property with rooms
// configured (Dona's Villa), roomIds is required and the price is the sum
// of the selected rooms' own pricePerNight — see
// BACKEND_CHANGES_SRI_LANKA_ROOMS.md. Either way this also validates guest
// count / minNights / (room count or room selection) against the
// property's actual configuration, same as how marketplace orders snapshot
// productPrice from the DB rather than trust the client.
export async function computeBookingPrice(
  propertyId: string,
  checkIn: Date,
  checkOut: Date,
  guests: number,
  rooms: number,
  childrenUnder14 = 0,
  roomIds?: string[]
) {
  const property = await prisma.property.findUnique({ where: { id: propertyId } });
  if (!property) throw ApiError.notFound("Property not found");

  const nights = Math.round((checkOut.getTime() - checkIn.getTime()) / MS_PER_DAY);
  if (nights < 1) throw ApiError.badRequest("checkOut must be after checkIn");
  if (nights < property.minNights) {
    throw ApiError.badRequest(`This property requires a minimum stay of ${property.minNights} night(s)`);
  }
  if (guests < 1 || guests > property.maxGuests) {
    throw ApiError.badRequest(`Guest count must be between 1 and ${property.maxGuests} for this property`);
  }

  // Enforces the property's cleaning/turnover gap between stays. This is an
  // application-level check only — unlike the exact-overlap case (which the
  // DB exclusion constraints guarantee even under concurrency), there's no
  // per-property-configurable buffer expressible in those constraints, so two
  // requests racing for buffer-adjacent dates at the same instant is a
  // theoretical residual risk, same class as the Airbnb sync-lag risk in
  // BACKEND_PLAN.md §4. Low-stakes enough not to warrant a locking scheme.
  // Applies at the whole-property level regardless of rooms — unaffected by
  // any of the room logic below.
  if (property.turnoverBufferDays > 0) {
    const bufferMs = property.turnoverBufferDays * MS_PER_DAY;
    const tooClose = await prisma.availabilityBlock.findFirst({
      where: {
        propertyId,
        status: "active",
        startDate: { lt: new Date(checkOut.getTime() + bufferMs) },
        endDate: { gt: new Date(checkIn.getTime() - bufferMs) },
      },
    });
    if (tooClose) {
      throw ApiError.conflict(
        `This property needs ${property.turnoverBufferDays} day(s) of turnover between bookings — these dates are too close to an existing booking or block.`
      );
    }
  }

  const activeRoomCount = await prisma.room.count({ where: { propertyId, active: true } });
  const nightDates = nightlyDates(checkIn, nights);

  let selectedRooms: Awaited<ReturnType<typeof prisma.room.findMany>> = [];
  let nightlyBasePrices: number[]; // post-RateOverride, pre-discount — one entry per night

  if (activeRoomCount > 0) {
    // Room-booking property — roomIds is how the guest picks, not a count.
    if (!roomIds || roomIds.length === 0) {
      throw ApiError.badRequest("This property books by individual room — select at least one room");
    }
    selectedRooms = await prisma.room.findMany({
      where: { id: { in: roomIds }, propertyId, active: true },
    });
    // Catches an unknown id, a room belonging to a different property, an
    // inactive (retired) room, or a duplicate id in the array all at once —
    // any of those means the count of matched rows won't equal the count asked for.
    if (selectedRooms.length !== roomIds.length) {
      throw ApiError.badRequest("One or more selected rooms are invalid for this property");
    }
    const totalCapacity = selectedRooms.reduce((sum, r) => sum + r.capacity, 0);
    if (totalCapacity < guests) {
      throw ApiError.badRequest(
        `The selected room(s) sleep ${totalCapacity} — select more rooms for a party of ${guests}`
      );
    }

    // Broad overlap fetch (one query for the whole stay) — exact per-night
    // matching happens in memory via resolveRoomNightlyPrice below.
    const roomOverrides = await prisma.rateOverride.findMany({
      where: {
        propertyId,
        roomId: { in: selectedRooms.map((r) => r.id) },
        startDate: { lte: checkOut },
        endDate: { gte: checkIn },
      },
    });
    nightlyBasePrices = nightDates.map((date) =>
      selectedRooms.reduce((sum, room) => sum + resolveRoomNightlyPrice(room, roomOverrides, date), 0)
    );
  } else {
    // Non-room property — unchanged PricingTier lookup, now with per-night overrides.
    if (roomIds && roomIds.length > 0) {
      throw ApiError.badRequest("This property doesn't book by individual room");
    }
    const tier = await prisma.pricingTier.findUnique({
      where: { propertyId_guestCount_rooms: { propertyId, guestCount: guests, rooms } },
    });
    if (!tier) {
      throw ApiError.badRequest(`No price is configured for ${guests} guest(s) in ${rooms} room(s) at this property`);
    }
    const basePricePerNight = Number(tier.pricePerNight);

    const tierOverrides = await prisma.rateOverride.findMany({
      where: {
        propertyId,
        guestCount: guests,
        rooms,
        startDate: { lte: checkOut },
        endDate: { gte: checkIn },
      },
    });
    nightlyBasePrices = nightDates.map((date) =>
      resolveTierNightlyPrice(guests, rooms, basePricePerNight, tierOverrides, date)
    );
  }

  // Date-scoped discounts (BACKEND_CHANGES_PRICING_DISCOUNTS_SHIPPING.md
  // §2) — resolved per night, on top of whatever RateOverride already
  // applied for that night.
  const activeOffers = await prisma.offer.findMany({ where: { propertyId, active: true } });

  let accommodationPrice = 0;
  let cityTax = 0;
  for (let i = 0; i < nights; i++) {
    const nightBasePrice = nightlyBasePrices[i]; // post-override, pre-discount — the "underlying rate"
    const discountPercent = resolveNightlyDiscountPercent(activeOffers, nightDates[i]);
    accommodationPrice += nightBasePrice * (1 - discountPercent / 100);

    // City tax bands off the underlying rate (post-override), not what the
    // guest actually ends up charged after a discount — same reasoning as
    // totalPriceOverride's cityTax handling in createOfflineBooking below —
    // and only for the first cityTaxMaxNights of the stay.
    if (i < property.cityTaxMaxNights) {
      cityTax += computeCityTaxForNight(property, nightBasePrice, guests, childrenUnder14);
    }
  }
  const pricePerNight = nights > 0 ? accommodationPrice / nights : 0; // average actually-charged nightly rate, informational

  return {
    property,
    nights,
    pricePerNight,
    accommodationPrice,
    cityTax,
    totalPrice: accommodationPrice + cityTax, // <- what actually gets charged
    currency: property.currency,
    rooms: selectedRooms, // empty for a non-room booking
  };
}

export interface CreatePendingBookingInput {
  propertyId: string;
  guestName: string;
  guestEmail: string;
  guestPhone: string;
  guestIdDocumentType?: string;
  guestIdDocumentNumber?: string;
  checkIn: Date;
  checkOut: Date;
  guests: number;
  rooms: number;
  childrenUnder14?: number;
  roomIds?: string[];
}

// Creates the AvailabilityBlock row(s) for a booking inside its transaction
// — one whole-property block (roomId null) for a non-room booking, exactly
// as before, or one block per reserved room for a room-booking (still one
// row per room for admin visibility, even though whole-villa locking below
// means any one of them blocks the entire property).
//
// Whole-villa locking (BACKEND_CHANGES_PRICING_DISCOUNTS_SHIPPING.md §3,
// supersedes the independent-per-room-availability design
// BACKEND_CHANGES_SRI_LANKA_ROOMS.md originally shipped): only one party
// occupies the property at a time, so this booking's block(s) must not
// overlap ANY other active block for the property, regardless of room.
// Two DIFFERENT bookings conflicting is caught by the DB exclusion
// constraint on INSERT (bookingId <>, see SUPABASE_SETUP.md) via the outer
// try/catch in each caller below — that constraint is specifically built to
// exempt this booking's own several per-room blocks (same bookingId) from
// conflicting with EACH OTHER while still catching every other booking.
// The one case it can't express — an existing manual/Airbnb block
// (bookingId IS NULL) — is checked explicitly here, via the same tx client
// so it sees anything already written earlier in this same transaction.
// Narrow, low-frequency residual race (manual/Airbnb writes are infrequent
// admin/import actions, not high-concurrency guest-facing ones) — same
// accepted-risk class as the turnoverBufferDays check above.
async function createBookingAvailabilityBlocks(
  tx: Prisma.TransactionClient,
  propertyId: string,
  bookingId: string,
  checkIn: Date,
  checkOut: Date,
  rooms: { id: string }[]
) {
  const nonBookingBlock = await tx.availabilityBlock.findFirst({
    where: {
      propertyId,
      bookingId: null,
      status: "active",
      startDate: { lt: checkOut },
      endDate: { gt: checkIn },
    },
  });
  if (nonBookingBlock) {
    throw ApiError.conflict("These dates are no longer available for this property.");
  }

  if (rooms.length === 0) {
    await tx.availabilityBlock.create({
      data: {
        propertyId,
        startDate: checkIn,
        endDate: checkOut,
        source: "direct",
        status: "active",
        bookingId,
      },
    });
    return;
  }

  for (const room of rooms) {
    await tx.availabilityBlock.create({
      data: {
        propertyId,
        roomId: room.id,
        startDate: checkIn,
        endDate: checkOut,
        source: "direct",
        status: "active",
        bookingId,
      },
    });
  }
}

export async function createPendingBooking(input: CreatePendingBookingInput) {
  const priced = await computeBookingPrice(
    input.propertyId,
    input.checkIn,
    input.checkOut,
    input.guests,
    input.rooms,
    input.childrenUnder14,
    input.roomIds
  );
  const expiresAt = new Date(Date.now() + env.bookingHoldMinutes * 60_000);
  const roomIds = priced.rooms.map((r) => r.id);

  try {
    const booking = await prisma.$transaction(async (tx) => {
      const booking = await tx.booking.create({
        data: {
          propertyId: input.propertyId,
          guestName: input.guestName,
          guestEmail: input.guestEmail,
          guestPhone: input.guestPhone,
          guestIdDocumentType: input.guestIdDocumentType,
          guestIdDocumentNumber: input.guestIdDocumentNumber,
          checkIn: input.checkIn,
          checkOut: input.checkOut,
          guests: input.guests,
          rooms: roomIds.length > 0 ? roomIds.length : input.rooms,
          roomIds,
          accommodationPrice: priced.accommodationPrice,
          cityTax: priced.cityTax,
          childrenUnder14: input.childrenUnder14 ?? 0,
          totalPrice: priced.totalPrice,
          currency: priced.currency,
          status: "pending_payment",
          expiresAt,
        },
      });

      await createBookingAvailabilityBlocks(
        tx,
        input.propertyId,
        booking.id,
        input.checkIn,
        input.checkOut,
        priced.rooms
      );

      return booking;
    });

    return { booking, property: priced.property };
  } catch (err) {
    if (isExclusionViolation(err)) {
      throw ApiError.conflict("These dates are no longer available for this property.");
    }
    throw err;
  }
}

// Admin: manual/offline booking (phone or walk-in guest), no Stripe involved.
// totalPriceOverride lets an admin honor a negotiated/special rate instead of
// the standard pricing-tier price — same pattern as cancelBooking's
// refundOverride below.
export async function createOfflineBooking(
  input: CreatePendingBookingInput & { totalPriceOverride?: number }
) {
  const priced = await computeBookingPrice(
    input.propertyId,
    input.checkIn,
    input.checkOut,
    input.guests,
    input.rooms,
    input.childrenUnder14,
    input.roomIds
  );
  const roomIds = priced.rooms.map((r) => r.id);

  // totalPriceOverride has always meant "this exact figure is what gets
  // charged" — preserved here rather than adding cityTax on top of it (which
  // would silently charge more than the number an admin typed in). City tax
  // is still computed from the standard tier rate per the comune's rule
  // (banded on the underlying price, not the actual charge — see
  // BACKEND_CHANGES_CITY_TAX.md), and backed out of the override so
  // accommodationPrice + cityTax still equals totalPrice; clamped at 0 for
  // the pathological case of an override smaller than the tax alone.
  const totalPrice = input.totalPriceOverride ?? priced.totalPrice;
  const cityTax = priced.cityTax;
  const accommodationPrice = input.totalPriceOverride === undefined
    ? priced.accommodationPrice
    : Math.max(0, totalPrice - cityTax);

  try {
    return await prisma.$transaction(async (tx) => {
      const booking = await tx.booking.create({
        data: {
          propertyId: input.propertyId,
          guestName: input.guestName,
          guestEmail: input.guestEmail,
          guestPhone: input.guestPhone,
          guestIdDocumentType: input.guestIdDocumentType,
          guestIdDocumentNumber: input.guestIdDocumentNumber,
          checkIn: input.checkIn,
          checkOut: input.checkOut,
          guests: input.guests,
          rooms: roomIds.length > 0 ? roomIds.length : input.rooms,
          roomIds,
          accommodationPrice,
          cityTax,
          childrenUnder14: input.childrenUnder14 ?? 0,
          totalPrice,
          currency: priced.currency,
          status: "paid_offline",
        },
      });

      await createBookingAvailabilityBlocks(
        tx,
        input.propertyId,
        booking.id,
        input.checkIn,
        input.checkOut,
        priced.rooms
      );

      return booking;
    });
  } catch (err) {
    if (isExclusionViolation(err)) {
      throw ApiError.conflict("These dates are no longer available for this property.");
    }
    throw err;
  }
}

export function attachPaymentIntent(bookingId: string, stripePaymentIntentId: string) {
  return prisma.booking.update({ where: { id: bookingId }, data: { stripePaymentIntentId } });
}

export async function confirmBooking(stripePaymentIntentId: string) {
  const result = await prisma.booking.updateMany({
    where: { stripePaymentIntentId, status: "pending_payment" },
    data: { status: "confirmed" },
  });
  return result;
}

export function getBooking(id: string) {
  return prisma.booking.findUnique({ where: { id }, include: { property: true } });
}

export function getBookingByPaymentIntent(stripePaymentIntentId: string) {
  return prisma.booking.findFirst({ where: { stripePaymentIntentId }, include: { property: true } });
}

// Called when something after the hold was created fails before the guest
// ever received a clientSecret (e.g. Stripe PaymentIntent creation errors) —
// without this, the hold would just sit there un-payable until the
// booking-expiry cron eventually cleans it up, blocking those dates for
// nothing in the meantime. Scoped to pending_payment so it can't clobber a
// booking that raced to confirmed/cancelled in between.
export async function releasePendingBooking(bookingId: string) {
  await prisma.$transaction([
    prisma.booking.updateMany({
      where: { id: bookingId, status: "pending_payment" },
      data: { status: "cancelled", cancelledAt: new Date() },
    }),
    prisma.availabilityBlock.updateMany({
      where: { bookingId, status: "active" },
      data: { status: "cancelled" },
    }),
  ]);
}

export function listBookingsForProperty(propertyId: string, status?: string) {
  return prisma.booking.findMany({
    where: { propertyId, ...(status ? { status: status as never } : {}) },
    orderBy: { checkIn: "asc" },
  });
}

// Cancels an expired pending_payment hold and frees the dates. Called by the
// booking-expiry job (src/jobs/bookingExpiry.ts) on a schedule.
export async function expireStalePendingBookings() {
  const stale = await prisma.booking.findMany({
    where: { status: "pending_payment", expiresAt: { lt: new Date() } },
  });

  for (const booking of stale) {
    await prisma.$transaction([
      prisma.booking.update({ where: { id: booking.id }, data: { status: "cancelled", cancelledAt: new Date() } }),
      prisma.availabilityBlock.updateMany({ where: { bookingId: booking.id }, data: { status: "cancelled" } }),
    ]);
  }

  return stale.length;
}

// Default policy from BACKEND_PLAN.md §9, overridable per property later.
// Deliberate decision (BACKEND_CHANGES_CITY_TAX.md §4): this runs off
// totalPrice, which now includes cityTax, so a full/partial refund refunds
// the tax portion too rather than carving it out. Treated as correct rather
// than an accidental side effect — the guest never stayed, so the tax was
// never actually owed to the comune either.
export function computeRefundAmount(totalPrice: number, checkIn: Date, now = new Date()) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysUntilCheckIn = (checkIn.getTime() - now.getTime()) / msPerDay;

  if (daysUntilCheckIn >= 7) return totalPrice;
  if (daysUntilCheckIn >= 3) return totalPrice * 0.5;
  return 0;
}

export async function cancelBooking(bookingId: string, refundOverride?: number, reason?: string) {
  const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
  const refundAmount =
    refundOverride ?? computeRefundAmount(Number(booking.totalPrice), booking.checkIn);

  // Capture the update's own result rather than returning the pre-fetch
  // above — that row is stale the moment the transaction commits (still
  // shows the pre-cancellation status/cancelledAt), which used to be what
  // this function handed back to the API caller.
  const [updatedBooking] = await prisma.$transaction([
    prisma.booking.update({
      where: { id: bookingId },
      data: { status: "cancelled", cancelledAt: new Date(), refundAmount, refundReason: reason },
    }),
    prisma.availabilityBlock.updateMany({ where: { bookingId }, data: { status: "cancelled" } }),
  ]);

  // Actual Stripe refund call happens in modules/payments — triggered from the controller
  // so this service function stays payment-provider agnostic.
  return { booking: updatedBooking, refundAmount };
}
