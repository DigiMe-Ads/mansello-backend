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
  });

  let intent;
  try {
    intent = await paymentService.createPaymentIntent(
      property.stripeAccountRef as StripeAccountRef,
      Number(booking.totalPrice),
      booking.currency,
      booking.id
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
    totalPriceOverride: req.body.totalPriceOverride,
  });
  res.status(201).json(booking);
}

export async function getBooking(req: Request, res: Response) {
  const booking = await bookingService.getBooking(req.params.id);
  if (!booking) throw ApiError.notFound("Booking not found");
  res.json(booking);
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
