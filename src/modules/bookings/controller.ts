import { Request, Response } from "express";
import { ApiError } from "@/utils/ApiError";
import * as bookingService from "./service";
import * as paymentService from "@/modules/payments/service";
import { StripeAccountRef } from "@/modules/payments/stripeClients";
import { assertPropertyScope } from "@/middleware/auth";
import { maskEmail } from "@/utils/redact";

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

// Public, unauthenticated — the booking confirmation page and the payment-
// status poll hit it with just the booking id. Returns only what those pages
// render (BACKEND_CHANGES_SECURITY_AUDIT_FRONTEND.md M4): no name, phone, ID
// document, PaymentIntent id or property secrets, and the email masked
// ("c•••@gmail.com") for "a confirmation has been sent to …". Admin callers
// use the scoped list endpoint instead, which returns the full rows.
export async function getBooking(req: Request, res: Response) {
  const booking = await bookingService.getBooking(req.params.id);
  if (!booking) throw ApiError.notFound("Booking not found");
  res.json({
    id: booking.id,
    status: booking.status,
    propertyId: booking.propertyId,
    property: { id: booking.property.id, name: booking.property.name, slug: booking.property.slug },
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    guests: booking.guests,
    rooms: booking.rooms,
    roomIds: booking.roomIds,
    childrenUnder14: booking.childrenUnder14,
    currency: booking.currency,
    accommodationPrice: booking.accommodationPrice,
    cityTax: booking.cityTax,
    transportPrice: booking.transportPrice,
    totalPrice: booking.totalPrice,
    expiresAt: booking.expiresAt,
    createdAt: booking.createdAt,
    guestEmail: maskEmail(booking.guestEmail),
  });
}

export async function listBookings(req: Request, res: Response) {
  const { status } = req.query as { status?: string };
  res.json(await bookingService.listBookingsForProperty(req.params.propertyId, status));
}

// Guards, refund maths and the Stripe refund itself live in
// bookingService.cancelBooking. A failed Stripe refund doesn't fail the
// request (the booking IS cancelled) — it comes back as `refundError` on the
// booking so the admin can see money is still owed.
export async function cancelBooking(req: Request, res: Response) {
  const booking = await bookingService.getBooking(req.params.id);
  if (!booking) throw ApiError.notFound("Booking not found");
  assertPropertyScope(req, booking.propertyId);
  res.json(await bookingService.cancelBooking(booking.id, req.body.refundOverride, req.body.reason));
}
