import { Router } from "express";
import express from "express";
import Stripe from "stripe";
import { asyncHandler } from "@/utils/asyncHandler";
import { getStripeClient, getWebhookSecret } from "./stripeClients";
import * as bookings from "@/modules/bookings/service";
import { sendBookingConfirmation } from "@/modules/notifications/email";

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
          const result = await bookings.confirmBooking(intent.id);
          if (result.count === 0) {
            // Either already confirmed (duplicate delivery — Stripe retries webhooks) or
            // the pending_payment hold already expired and got cancelled before payment
            // landed. Either way there's nothing to confirm, just log for visibility.
            console.warn(
              `[stripe:${accountRef}] payment_intent.succeeded for ${intent.id} matched no pending_payment booking (already confirmed or expired)`
            );
            break;
          }

          console.log(`[stripe:${accountRef}] confirmed booking for PaymentIntent ${intent.id}`);
          const booking = await bookings.getBookingByPaymentIntent(intent.id);
          if (booking) {
            await sendBookingConfirmation(
              booking.guestEmail,
              booking.guestName,
              booking.property.name,
              booking.checkIn.toISOString().slice(0, 10),
              booking.checkOut.toISOString().slice(0, 10)
            );
          }
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
