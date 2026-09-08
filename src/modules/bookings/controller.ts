import { Request, Response } from "express";
import { ApiError } from "@/utils/ApiError";
import * as bookingService from "./service";
import * as paymentService from "@/modules/payments/service";
import { StripeAccountRef } from "@/modules/payments/stripeClients";

// Guest starts checkout: creates a pending_payment hold (occupies the dates
// immediately via the exclusion constraint) and a matching Stripe PaymentIntent.
// Price is always computed server-side from the property's PricingTier —
// never trust a client-supplied amount.
export async function startBooking(req: Request, res: Response) {
  const { booking, property } = await bookingService.createPendingBooking({
    propertyId: req.body.propertyId,
    guestName: req.body.guestName,
    guestEmail: req.body.guestEmail,
    guestPhone: req.body.guestPhone,
    guestIdDocumentType: req.body.guestIdDocumentType,
    guestIdDocumentNumber: req.body.guestIdDocumentNumber,
    checkIn: new Date(req.body.checkIn),
    checkOut: new Date(req.body.checkOut),
    guests: req.body.guests,
    rooms: req.body.rooms ?? 1,
    childrenUnder14: req.body.childrenUnder14,
    roomIds: req.body.roomIds,
    transportRequested: req.body.transportRequested,
  });

  let intent;
  try {
    intent = await paymentService.createPaymentIntent(
      property.stripeAccountRef as StripeAccountRef,
      Number(booking.totalPrice),
      booking.currency,
      { type: "booking", bookingId: booking.id }
    );
  } catch (err) {
    // The hold (booking + AvailabilityBlock) already exists at this point —
    // if we can't hand the guest a clientSecret, free the dates immediately
    // instead of leaving an unpayable hold to expire on its own.
    await bookingService.releasePendingBooking(booking.id);
    throw err;
  }
  await bookingService.attachPaymentIntent(booking.id, intent.id);

  res.status(201).json({ booking, clientSecret: intent.client_secret });
}

export async function createOfflineBooking(req: Request, res: Response) {
  const booking = await bookingService.createOfflineBooking({
    propertyId: req.body.propertyId,
    guestName: req.body.guestName,
    guestEmail: req.body.guestEmail,
    guestPhone: req.body.guestPhone,
    guestIdDocumentType: req.body.guestIdDocumentType,
    guestIdDocumentNumber: req.body.guestIdDocumentNumber,
    checkIn: new Date(req.body.checkIn),
    checkOut: new Date(req.body.checkOut),
    guests: req.body.guests,
    rooms: req.body.rooms ?? 1,
    childrenUnder14: req.body.childrenUnder14,
    roomIds: req.body.roomIds,
    transportRequested: req.body.transportRequested,
    totalPriceOverride: req.body.totalPriceOverride,
  });
  res.status(201).json(booking);
}

// Public, unauthenticated (this route has no requireAuth — the booking
// confirmation page hits it directly with just the booking id). The id is a
// random UUIDv4, which is a reasonable secrecy bar for the rest of the
// booking, but a passport/ID number is meaningfully more sensitive than
// that bar was ever meant to protect — stripped here regardless of id
// entropy. See BACKEND_CHANGES_SEO_SECURITY_HARDENING.md §6.2. This is a
// response-shaping choice, not a service-layer one: bookingService.getBooking
// is also used by admin-authed callers (cancelBooking, guestInfo's
// assertBookingScope) that still need the real fields.
//
// Also strips two property-internal secrets found during testing of the
// above (not named in the doc, but the same class of problem): the
// embedded `property` include carries `icalExportToken` (our own calendar
// export secret) and `airbnbIcalImportUrls` (each one embeds Airbnb's own
// per-listing secret token) — neither has any business on a guest-facing
// booking confirmation, and both would otherwise leak to anyone who learns
// any booking id for that property.
export async function getBooking(req: Request, res: Response) {
  const booking = await bookingService.getBooking(req.params.id);
  if (!booking) throw ApiError.notFound("Booking not found");
  const { guestIdDocumentType: _type, guestIdDocumentNumber: _number, ...publicBooking } = booking;
  const { icalExportToken: _icalToken, airbnbIcalImportUrls: _airbnbUrls, ...publicProperty } = publicBooking.property;
  res.json({ ...publicBooking, property: publicProperty });
}

export async function listBookings(req: Request, res: Response) {
  const { status } = req.query as { status?: string };
  res.json(await bookingService.listBookingsForProperty(req.params.propertyId, status));
}

export async function cancelBooking(req: Request, res: Response) {
  const booking = await bookingService.getBooking(req.params.id);
  if (!booking) throw ApiError.notFound("Booking not found");

  const { booking: cancelled, refundAmount } = await bookingService.cancelBooking(
    req.params.id,
    req.body.refundOverride,
    req.body.reason
  );

  if (booking.stripePaymentIntentId && refundAmount > 0) {
    await paymentService.refundPaymentIntent(
      booking.property.stripeAccountRef as StripeAccountRef,
      booking.stripePaymentIntentId,
      refundAmount
    );
  }

  res.json(cancelled);
}
