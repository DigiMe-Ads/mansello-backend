import { Router } from "express";
import express from "express";
import Stripe from "stripe";
import { asyncHandler } from "@/utils/asyncHandler";
import { getStripeClient, getWebhookSecret } from "./stripeClients";
import * as bookings from "@/modules/bookings/service";
import * as orders from "@/modules/marketplace/orders/service";
import { sendBookingConfirmation, sendLatePaymentRefund } from "@/modules/notifications/email";

// An email failure must not fail the webhook: Stripe would retry, the retry
// would find the booking already confirmed, and the email would never be sent
// at all (BACKEND_SECURITY_AUDIT.md M3). Logged for follow-up instead.
async function sendConfirmationEmail(paymentIntentId: string) {
  const booking = await bookings.getBookingByPaymentIntent(paymentIntentId);
  if (!booking) return;
  try {
    await sendBookingConfirmation(
      booking.guestEmail,
      booking.guestName,
      booking.property.name,
      booking.checkIn.toISOString().slice(0, 10),
      booking.checkOut.toISOString().slice(0, 10)
    );
  } catch (err) {
    console.error(`Booking confirmation email failed for booking ${booking.id}:`, err);
  }
}

async function sendLateRefundEmail(paymentIntentId: string) {
  const booking = await bookings.getBookingByPaymentIntent(paymentIntentId);
  if (!booking) return;
  try {
    await sendLatePaymentRefund(
      booking.guestEmail,
      booking.guestName,
      booking.property.name,
      booking.checkIn.toISOString().slice(0, 10),
      booking.checkOut.toISOString().slice(0, 10)
    );
  } catch (err) {
    console.error(`Late-payment refund email failed for booking ${booking.id}:`, err);
  }
}

function makeWebhookRouter(accountRef: "italy" | "sri_lanka") {
  const router = Router();

  // Stripe requires the raw, unparsed body to verify the signature — this
  // router is mounted before express.json() in app.ts.
  router.post(
    "/",
    express.raw({ type: "application/json" }),
    asyncHandler(async (req, res) => {
      const signature = req.headers["stripe-signature"];
      const stripe = getStripeClient(accountRef);

      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(req.body, signature as string, getWebhookSecret(accountRef));
      } catch (err) {
        console.error(`[stripe:${accountRef}] webhook signature verification failed:`, (err as Error).message);
        return res.status(400).send(`Webhook signature verification failed: ${(err as Error).message}`);
      }

      console.log(`[stripe:${accountRef}] received webhook event ${event.type} (${event.id})`);

      switch (event.type) {
        case "payment_intent.succeeded": {
          const intent = event.data.object as Stripe.PaymentIntent;
          // Metadata always carries `type` for a PaymentIntent created after
          // BACKEND_CHANGES_MARKETPLACE_PAYMENTS.md (see
          // modules/payments/service.ts createPaymentIntent); missing/anything
          // else falls back to the booking branch, which is what every
          // PaymentIntent created before that change looks like.
          if (intent.metadata?.type === "marketplace_order") {
            // Confirms a pending order, reinstates one whose payment arrived
            // after it expired, or refunds one that can no longer be
            // fulfilled (out of stock) — see confirmOrderByPaymentIntent.
            const outcome = await orders.confirmOrderByPaymentIntent(intent.id);
            console.log(`[stripe:${accountRef}] marketplace PaymentIntent ${intent.id}: ${outcome}`);
            break;
          }

          const result = await bookings.confirmBooking(intent.id);
          if (result.count === 0) {
            // Either a duplicate delivery (already confirmed — nothing to do)
            // or a payment that landed after the hold expired. The latter is
            // reinstated if the dates are still free, refunded otherwise —
            // never left as "charged with no booking" (BACKEND_SECURITY_AUDIT.md H2).
            const outcome = await bookings.handleLateBookingPayment(intent.id);
            console.warn(`[stripe:${accountRef}] PaymentIntent ${intent.id} matched no pending booking: ${outcome}`);
            if (outcome === "reinstated") await sendConfirmationEmail(intent.id);
            if (outcome === "refunded") await sendLateRefundEmail(intent.id);
            break;
          }

          console.log(`[stripe:${accountRef}] confirmed booking for PaymentIntent ${intent.id}`);
          await sendConfirmationEmail(intent.id);
          break;
        }
        case "payment_intent.payment_failed": {
          const intent = event.data.object as Stripe.PaymentIntent;
          console.warn(`[stripe:${accountRef}] payment_intent.payment_failed for ${intent.id}`);
          // Left as pending_payment; the hold still expires naturally via the
          // booking-expiry job so the dates free up on their own.
          break;
        }
        default:
          break;
      }

      res.json({ received: true });
    })
  );

  return router;
}

export const italyWebhookRouter = makeWebhookRouter("italy");
export const sriLankaWebhookRouter = makeWebhookRouter("sri_lanka");
