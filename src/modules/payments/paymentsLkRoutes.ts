import express, { Router } from "express";
import {
  constructEvent,
  type Payment as PaymentsLkPayment,
  type WebhookEvent,
  type WebhookTestPing,
} from "@payments-lk/node";
import { env } from "@/config/env";
import { prisma } from "@/db/prisma";
import { asyncHandler } from "@/utils/asyncHandler";
import { ApiError } from "@/utils/ApiError";
import * as bookings from "@/modules/bookings/service";
import * as orders from "@/modules/marketplace/orders/service";
import { alertAdmin } from "@/modules/notifications/email";
import { toCents, verifyCancelSignature } from "./paymentsLk";
import { applyRefundEvent } from "./lkRefunds";
import { emailBookingConfirmed, emailLatePaymentRefund } from "./webhooks";

// Payments.lk webhook and the hosted checkout's cancel link —
// BACKEND_CHANGES_VARIANTS_CALENDAR_PAYMENTS_LK.md §3. The webhook is the
// only thing that ever confirms a Payments.lk payment; the customer's return
// to successUrl proves nothing. Deliveries are retried for up to a day, so
// every handler here is safe to run twice.

// --- Webhook (mounted before express.json — the signature covers the raw body)

export const paymentsLkWebhookRouter = Router();

paymentsLkWebhookRouter.post(
  "/",
  express.raw({ type: () => true, limit: "1mb" }),
  asyncHandler(async (req, res) => {
    if (!env.paymentsLk.webhookSecret) {
      // 503 so Payments.lk keeps retrying until the secret is configured.
      console.error("[payments-lk] webhook received but PAYMENTS_LK_WEBHOOK_SECRET is not set");
      return res.sendStatus(503);
    }

    let event: WebhookEvent | WebhookTestPing;
    try {
      event = constructEvent(req.body as Buffer, req.headers["payments-signature"], env.paymentsLk.webhookSecret);
    } catch {
      console.warn("[payments-lk] webhook with an invalid signature rejected");
      return res.sendStatus(400);
    }
    console.log(`[payments-lk] webhook ${event.type} (${event.id}, ${event.mode})`);

    // A handler that throws (e.g. the database is briefly down) answers 500,
    // and Payments.lk delivers the event again later. Emails never throw.
    switch (event.type) {
      case "payment.succeeded":
        await onPaymentSucceeded(event.data);
        break;
      case "payment.failed":
        // Left pending: the guest can retry on the hosted page until the
        // hold expires (or the checkout does).
        console.warn(`[payments-lk] payment ${event.data.id} failed (${event.data.reference}): ${event.data.failureMessage}`);
        break;
      case "checkout.expired":
        await onCheckoutExpired(event.data.id);
        break;
      case "refund.succeeded":
      case "refund.failed":
        await applyRefundEvent(event.type, event.data);
        break;
      case "account.limit.approaching":
      case "account.limit.reached":
        await alertAdmin(
          event.type === "account.limit.reached"
            ? "Payments.lk monthly limit reached — card payments are paused"
            : `Payments.lk monthly limit at ${event.data.threshold}%`,
          [
            `Card payments this month (${event.data.month}): LKR ${(event.data.settledCents / 100).toFixed(2)}` +
              (event.data.capCents ? ` of LKR ${(event.data.capCents / 100).toFixed(2)} (${event.data.percent}%).` : "."),
            event.type === "account.limit.reached"
              ? `New checkouts are refused until the limit resets on ${event.data.resetsAt}; guests see "card payments are temporarily unavailable". Raising the plan in the Payments.lk dashboard lifts it sooner.`
              : `New checkouts will be refused once the limit is reached (resets ${event.data.resetsAt}).`,
          ]
        );
        break;
      case "account.limit.reset":
        console.log(`[payments-lk] monthly limit reset (${event.data.month})`);
        break;
      default:
        // test.ping and event types we don't use.
        break;
    }
    res.json({ received: true });
  })
);

async function findPaymentsLkRecord(payment: PaymentsLkPayment) {
  // The checkout id is the precise match; the reference (our booking/order
  // id) is the fallback for a payment without one.
  const where = payment.checkoutId
    ? { paymentsLkCheckoutId: payment.checkoutId }
    : payment.reference
      ? { id: payment.reference, paymentProvider: "payments_lk" }
      : null;
  if (!where) return null;
  const booking = await prisma.booking.findFirst({ where });
  if (booking) return { kind: "booking" as const, record: booking };
  const order = await prisma.order.findFirst({ where });
  return order ? { kind: "order" as const, record: order } : null;
}

async function onPaymentSucceeded(payment: PaymentsLkPayment) {
  const found = await findPaymentsLkRecord(payment);
  if (!found) {
    console.warn(`[payments-lk] payment ${payment.id} (checkout ${payment.checkoutId}, ref ${payment.reference}) matches no booking/order`);
    return;
  }
  const { kind, record } = found;

  // Never confirm on an amount other than the one we asked for.
  const expected = toCents(record.chargeAmount);
  if (payment.amountCents !== expected) {
    const note = `Payment ${payment.id} was for ${payment.amountCents} cents, expected ${expected} — not confirmed automatically.`;
    console.error(`[payments-lk] ${kind} ${record.id}: ${note}`);
    if (!record.paymentNote?.includes(payment.id)) {
      const data = { paymentNote: record.paymentNote ? `${record.paymentNote}\n${note}` : note };
      if (kind === "booking") await prisma.booking.update({ where: { id: record.id }, data });
      else await prisma.order.update({ where: { id: record.id }, data });
      await alertAdmin(`Payments.lk amount mismatch (${kind} ${record.id})`, [note]);
    }
    return;
  }

  if (kind === "booking") {
    const outcome = await bookings.confirmPaymentsLkBooking(record.id, payment.id);
    console.log(`[payments-lk] booking ${record.id}: ${outcome}`);
    if (outcome === "confirmed" || outcome === "reinstated") {
      await emailBookingConfirmed(await bookings.getBooking(record.id));
    } else if (outcome === "refunded") {
      await emailLatePaymentRefund(await bookings.getBooking(record.id));
    }
    return;
  }

  const outcome = await orders.confirmPaymentsLkOrder(record.id, payment.id);
  console.log(`[payments-lk] order ${record.id}: ${outcome}`);
}

// The checkout closed unpaid: release the hold now instead of waiting for the
// expiry job. A booking/order that's no longer pending is left alone.
async function onCheckoutExpired(checkoutId: string) {
  const booking = await prisma.booking.findUnique({ where: { paymentsLkCheckoutId: checkoutId }, select: { id: true } });
  if (booking) {
    await bookings.releasePendingBooking(booking.id);
    return;
  }
  const order = await prisma.order.findUnique({ where: { paymentsLkCheckoutId: checkoutId }, select: { id: true } });
  if (order) await orders.releaseUnpaidOrder(order.id);
}

// --- Cancel link -------------------------------------------------------------
// GET /api/payments-lk/return/cancel?kind=booking|order&id=…&sig=…
// Payments.lk sends the customer here when they cancel (or the payment fails
// or expires) on the hosted page. The signature stops anyone cancelling
// someone else's hold by guessing ids. A booking/order that has been paid in
// the meantime is left as it is.

export const paymentsLkReturnRouter = Router();

paymentsLkReturnRouter.get(
  "/cancel",
  asyncHandler(async (req, res) => {
    const { kind, id, sig } = req.query as Record<string, string | undefined>;
    if (!kind || !id || !sig || !verifyCancelSignature(kind, id, sig)) {
      throw ApiError.badRequest("This payment link is invalid.");
    }
    if (kind === "booking") {
      await bookings.releasePendingBooking(id);
      return res.redirect(303, `${env.publicSiteUrl}/sri-lanka/airbnb?payment=cancelled`);
    }
    await orders.releaseUnpaidOrder(id);
    res.redirect(303, `${env.publicSiteUrl}/sri-lanka/marketplace/checkout?payment=cancelled`);
  })
);
