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

// The price a guest pays is never taken from the request — it's always looked
// up from the property's own PricingTier table (guestCount x rooms), same as
// how marketplace orders snapshot productPrice from the DB rather than trust
// the client. This also validates guest count / room count / minNights against
// the property's actual configuration.
export async function computeBookingPrice(
  propertyId: string,
  checkIn: Date,
  checkOut: Date,
  guests: number,
  rooms: number
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
  // DB exclusion constraint guarantees even under concurrency), there's no
  // per-property-configurable buffer expressible in that constraint, so two
  // requests racing for buffer-adjacent dates at the same instant is a
  // theoretical residual risk, same class as the Airbnb sync-lag risk in
  // BACKEND_PLAN.md §4. Low-stakes enough not to warrant a locking scheme.
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

  const tier = await prisma.pricingTier.findUnique({
    where: { propertyId_guestCount_rooms: { propertyId, guestCount: guests, rooms } },
  });
  if (!tier) {
    throw ApiError.badRequest(`No price is configured for ${guests} guest(s) in ${rooms} room(s) at this property`);
  }

  return {
    property,
    nights,
    pricePerNight: Number(tier.pricePerNight),
    totalPrice: Number(tier.pricePerNight) * nights,
    currency: property.currency,
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
}

// The exclusion constraint (see SUPABASE_SETUP.md) is what actually prevents
// two concurrent requests from both winning the same date range — this
// transaction just needs to attempt the insert and translate a DB-level
// rejection into a clean 409 for the API caller.
export async function createPendingBooking(input: CreatePendingBookingInput) {
  const priced = await computeBookingPrice(
    input.propertyId,
    input.checkIn,
    input.checkOut,
    input.guests,
    input.rooms
  );
  const expiresAt = new Date(Date.now() + env.bookingHoldMinutes * 60_000);

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
          rooms: input.rooms,
          totalPrice: priced.totalPrice,
          currency: priced.currency,
          status: "pending_payment",
          expiresAt,
        },
      });

      await tx.availabilityBlock.create({
        data: {
          propertyId: input.propertyId,
          startDate: input.checkIn,
          endDate: input.checkOut,
          source: "direct",
          status: "active",
          bookingId: booking.id,
        },
      });

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
    input.rooms
  );
  const totalPrice = input.totalPriceOverride ?? priced.totalPrice;

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
          rooms: input.rooms,
          totalPrice,
          currency: priced.currency,
          status: "paid_offline",
        },
      });
      await tx.availabilityBlock.create({
        data: {
          propertyId: input.propertyId,
          startDate: input.checkIn,
          endDate: input.checkOut,
          source: "direct",
          status: "active",
          bookingId: booking.id,
        },
      });
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

  await prisma.$transaction([
    prisma.booking.update({
      where: { id: bookingId },
      data: { status: "cancelled", cancelledAt: new Date(), refundAmount, refundReason: reason },
    }),
    prisma.availabilityBlock.updateMany({ where: { bookingId }, data: { status: "cancelled" } }),
  ]);

  // Actual Stripe refund call happens in modules/payments — triggered from the controller
  // so this service function stays payment-provider agnostic.
  return { booking, refundAmount };
}
