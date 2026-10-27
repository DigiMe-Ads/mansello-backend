import { Router } from "express";
import { env } from "@/config/env";
import { prisma } from "@/db/prisma";
import { asyncHandler } from "@/utils/asyncHandler";
import { ApiError } from "@/utils/ApiError";
import * as bookings from "@/modules/bookings/service";
import * as orders from "@/modules/marketplace/orders/service";
import {
  DEAD_STATUSES,
  IN_FLIGHT_STATUSES,
  cryptoEnabled,
  parseCryptoOrderId,
  verifyCryptoCancelSignature,
  verifyIpn,
  type IpnPayload,
} from "./nowPayments";
import { emailBookingConfirmed } from "./webhooks";

// NOWPayments IPN (webhook) and the hosted invoice's cancel link — see
// nowPayments.ts. The IPN is the only thing that ever confirms a crypto
// payment. NOWPayments sends one IPN per status change and retries failed
// deliveries, so every branch here is safe to run twice.

export const nowPaymentsWebhookRouter = Router();

const cents = (v: unknown) => Math.round(Number(v) * 100);

nowPaymentsWebhookRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!cryptoEnabled()) {
      console.error("[nowpayments] IPN received but NOW_PAYMENTS_API / NOW_PAYMENTS_IPN are not set");
      return res.sendStatus(503);
    }
    if (!verifyIpn(req.body, req.headers["x-nowpayments-sig"])) {
      console.warn("[nowpayments] IPN with an invalid signature rejected");
      return res.sendStatus(400);
    }

    const ipn = req.body as IpnPayload;
    const ref = parseCryptoOrderId(ipn.order_id);
    const status = String(ipn.payment_status);
    console.log(`[nowpayments] IPN ${status} payment ${ipn.payment_id} (${ipn.order_id})`);
    if (!ref) return res.json({ received: true });

    const record =
      ref.kind === "booking"
        ? await prisma.booking.findUnique({ where: { id: ref.id } })
        : await prisma.order.findUnique({ where: { id: ref.id } });
    if (!record) {
      console.warn(`[nowpayments] IPN for unknown ${ref.kind} ${ref.id}`);
      return res.json({ received: true });
    }
    const expectedAmount = ref.kind === "booking" ? (record as { totalPrice: unknown }).totalPrice : (record as { total: unknown }).total;
    const expectedCurrency = ref.kind === "booking" ? (record as { currency: string }).currency : "usd";
    const paid = `${ipn.actually_paid ?? "?"} ${String(ipn.pay_currency ?? "").toUpperCase()}`;

    if (IN_FLIGHT_STATUSES.includes(status)) {
      if (ref.kind === "booking") await bookings.extendCryptoHold(ref.id);
    } else if (status === "partially_paid") {
      await bookings.flagCryptoPayment(
        ref.kind,
        ref.id,
        `Crypto payment ${ipn.payment_id} was underpaid: received ${paid} (expected ${ipn.pay_amount ?? "?"}). Not confirmed — check NOWPayments and contact the customer.`
      );
    } else if (status === "refunded") {
      await bookings.flagCryptoPayment(ref.kind, ref.id, `Crypto payment ${ipn.payment_id} was refunded in NOWPayments.`);
    } else if (DEAD_STATUSES.includes(status)) {
      // Only the invoice we're still waiting on releases the hold — an
      // abandoned older invoice must not cancel a booking paid another way.
      const current = record.nowPaymentsInvoiceId && String(ipn.invoice_id ?? "") === record.nowPaymentsInvoiceId;
      if (current && record.paymentProvider === "nowpayments") {
        if (ref.kind === "booking") await bookings.releasePendingBooking(ref.id);
        else await orders.releaseUnpaidOrder(ref.id);
      }
    } else if (status === "finished") {
      // Never confirm on an amount or currency other than the one we asked for.
      if (
        cents(ipn.price_amount) !== cents(expectedAmount) ||
        String(ipn.price_currency).toLowerCase() !== expectedCurrency.toLowerCase()
      ) {
        await bookings.flagCryptoPayment(
          ref.kind,
          ref.id,
          `Crypto payment ${ipn.payment_id} was for ${ipn.price_amount} ${String(ipn.price_currency).toUpperCase()}, expected ${Number(expectedAmount).toFixed(2)} ${expectedCurrency.toUpperCase()} (received ${paid}) — not confirmed automatically.`
        );
      } else if (ref.kind === "booking") {
        const outcome = await bookings.confirmCryptoBooking(ref.id, ipn);
        console.log(`[nowpayments] booking ${ref.id}: ${outcome}`);
        if (outcome === "confirmed" || outcome === "reinstated") {
          await emailBookingConfirmed(await bookings.getBooking(ref.id));
        }
      } else {
        const outcome = await orders.confirmCryptoOrder(ref.id, ipn);
        console.log(`[nowpayments] order ${ref.id}: ${outcome}`);
      }
    }
    res.json({ received: true });
  })
);

// GET /api/nowpayments/return/cancel?kind=booking|order&id=…&sig=…
// The customer pressed cancel on the NOWPayments page. Releases a booking
// hold / unpaid order still waiting on crypto; anything paid meanwhile is
// left alone.
export const nowPaymentsReturnRouter = Router();

nowPaymentsReturnRouter.get(
  "/cancel",
  asyncHandler(async (req, res) => {
    const { kind, id, sig } = req.query as Record<string, string | undefined>;
    if (!kind || !id || !sig || !verifyCryptoCancelSignature(kind, id, sig)) {
      throw ApiError.badRequest("This payment link is invalid.");
    }
    if (kind === "booking") {
      const booking = await prisma.booking.findUnique({ where: { id }, include: { property: true } });
      if (booking?.paymentProvider === "nowpayments") await bookings.releasePendingBooking(id);
      const site = booking?.property.stripeAccountRef === "italy" ? "italy" : "sri-lanka";
      return res.redirect(303, `${env.publicSiteUrl}/${site}/airbnb?payment=cancelled`);
    }
    const order = await prisma.order.findUnique({ where: { id } });
    if (order?.paymentProvider === "nowpayments") await orders.releaseUnpaidOrder(id);
    res.redirect(303, `${env.publicSiteUrl}/sri-lanka/marketplace/checkout?payment=cancelled`);
  })
);

// GET /api/payments/methods — which optional payment methods the site may
// offer right now (crypto only once its keys are configured).
export const paymentMethodsRouter = Router();
paymentMethodsRouter.get("/methods", (_req, res) => {
  res.json({ crypto: cryptoEnabled() });
});
