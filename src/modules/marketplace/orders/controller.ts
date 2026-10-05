import { Request, Response } from "express";
import { ApiError } from "@/utils/ApiError";
import * as paymentService from "@/modules/payments/service";
import * as service from "./service";
import { firstName, maskPhone } from "@/utils/redact";

// The marketplace has only ever existed on the Sri Lanka site and has no
// Stripe account of its own — it rides on the same "sri_lanka" account as
// Dona's Villa's bookings, matching the frontend's hardcoded
// getStripePromise("sri_lanka"). See BACKEND_CHANGES_MARKETPLACE_PAYMENTS.md.
const MARKETPLACE_STRIPE_ACCOUNT = "sri_lanka" as const;
// Product prices are always priceUsd — Order carries no currency field of
// its own for the same reason Booking does (there's only ever one).
const MARKETPLACE_CURRENCY = "usd";

// Guest checkout: creates a pending order and a matching Stripe
// PaymentIntent, same shape as startBooking in modules/bookings/controller.ts.
// Stock is NOT touched here — see createOrder's own comment.
export async function createOrder(req: Request, res: Response) {
  const order = await service.createOrder(req.body);

  let intent;
  try {
    intent = await paymentService.createPaymentIntent(
      MARKETPLACE_STRIPE_ACCOUNT,
      Number(order.total),
      MARKETPLACE_CURRENCY,
      { type: "marketplace_order", orderId: order.id }
    );
  } catch (err) {
    // Nothing to free (no availability hold like a booking has) — just mark
    // the otherwise-unpayable order cancelled instead of leaving a ghost
    // "pending" row with no way to ever pay it.
    await service.releaseUnpaidOrder(order.id);
    throw err;
  }
  await service.attachPaymentIntent(order.id, intent.id);

  res.status(201).json({ order, clientSecret: intent.client_secret });
}

export async function listOrders(req: Request, res: Response) {
  res.json(await service.listOrders(req.query.status as string | undefined));
}

// Public, unauthenticated — the order confirmation page. Returns only what
// that page renders (BACKEND_CHANGES_SECURITY_AUDIT_FRONTEND.md M4): first
// name and a masked phone, no address or notes. Admins use the list endpoint.
export async function getOrder(req: Request, res: Response) {
  const order = await service.getOrder(req.params.id);
  if (!order) throw ApiError.notFound("Order not found");
  res.json({
    id: order.id,
    status: order.status,
    createdAt: order.createdAt,
    items: order.items.map((i) => ({
      id: i.id,
      productId: i.productId,
      productNameSnapshot: i.productNameSnapshot,
      unitPriceSnapshot: i.unitPriceSnapshot,
      quantity: i.quantity,
      lineTotal: i.lineTotal,
    })),
    subtotal: order.subtotal,
    shippingFee: order.shippingFee,
    total: order.total,
    customerName: firstName(order.customerName),
    customerPhone: maskPhone(order.customerPhone),
  });
}

// Refunds (paid order cancelled/returned → full refund) and PaymentIntent
// cancellation (pending order cancelled) happen in service.updateOrderStatus,
// after the status change commits; a failed refund comes back as
// `refundError` on the order instead of failing the request.
export async function updateOrderStatus(req: Request, res: Response) {
  const before = await service.getOrder(req.params.id);
  if (!before) throw ApiError.notFound("Order not found");

  const nextStatus = req.body.status;

  // Before BACKEND_CHANGES_MARKETPLACE_PAYMENTS.md, a manual "confirmed"
  // transition meant "staff verified this COD order by phone" — now that
  // every order requires real payment, letting that same override fire
  // without checking Stripe first would let an admin decrement real stock
  // (and set up a later refund attempt that fails, since there was never
  // a successful charge to refund) for an order nobody actually paid for.
  // This still supports confirmOrder's documented recovery case — the
  // webhook was missed but the charge genuinely succeeded — just verifies
  // that against Stripe instead of trusting the request.
  if (nextStatus === "confirmed" && before.status === "pending") {
    if (!before.stripePaymentIntentId) {
      throw ApiError.badRequest("This order has no PaymentIntent yet — nothing to confirm");
    }
    const intent = await paymentService.getPaymentIntent(MARKETPLACE_STRIPE_ACCOUNT, before.stripePaymentIntentId);
    if (intent.status !== "succeeded") {
      throw ApiError.badRequest(`PaymentIntent status is "${intent.status}", not "succeeded" — refusing to confirm`);
    }
  }

  res.json(await service.updateOrderStatus(req.params.id, nextStatus));
}
