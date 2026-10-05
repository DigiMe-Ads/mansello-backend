import { Prisma } from "@prisma/client";
import { prisma } from "@/db/prisma";
import { ApiError } from "@/utils/ApiError";
import { computeShippingFee } from "@/modules/marketplace/shipping/service";
import { cancelPaymentIntentQuietly, refundPaymentIntent } from "@/modules/payments/service";

// The marketplace rides on the Sri Lanka Stripe account — see orders/controller.ts.
const MARKETPLACE_STRIPE_ACCOUNT = "sri_lanka" as const;

const COD_ABUSE_THRESHOLD = 3; // cancelled/returned orders before flagging

export interface OrderItemInput {
  productId: string;
  quantity: number;
}

// Guest checkout: price snapshot taken now, stock is NOT touched yet
// (decremented at `confirmed` — see confirmOrder below) so browsing an
// abandoned cart never ties up inventory.
export async function createOrder(input: {
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
  notes?: string;
  items: OrderItemInput[];
}) {
  const products = await prisma.product.findMany({
    where: { id: { in: input.items.map((i) => i.productId) }, active: true },
    include: { stockLevel: true },
  });
  if (products.length !== input.items.length) {
    throw ApiError.badRequest("One or more products are unavailable");
  }

  // Early, friendly check so the customer fixes their cart before paying.
  // Not a reservation — stock is only taken at confirmation, which re-checks
  // atomically (see takeStock).
  for (const item of input.items) {
    const product = products.find((p) => p.id === item.productId)!;
    assertInStock(product.name, product.stockLevel?.quantityOnHand ?? 0, item.quantity);
  }

  const lineItems = input.items.map((item) => {
    const product = products.find((p) => p.id === item.productId)!;
    const unitPriceSnapshot = Number(product.priceUsd);
    return {
      productId: product.id,
      productNameSnapshot: product.name,
      unitPriceSnapshot,
      quantity: item.quantity,
      lineTotal: unitPriceSnapshot * item.quantity,
    };
  });

  const subtotal = lineItems.reduce((sum, i) => sum + i.lineTotal, 0);
  // Computed server-side from the submitted items' weight and the current
  // ShippingRate table — never taken from the request. Closes the gap
  // BACKEND_PLAN.md §7 left open (shippingFee used to be a flat,
  // client-supplied value); see
  // BACKEND_CHANGES_PRICING_DISCOUNTS_SHIPPING.md §4.
  const shippingFee = await computeShippingFee(input.items, products);
  const total = subtotal + shippingFee;

  const priorAbuseCount = await prisma.order.count({
    where: { customerPhone: input.customerPhone, status: { in: ["cancelled", "returned"] } },
  });

  return prisma.order.create({
    data: {
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      deliveryAddress: input.deliveryAddress,
      notes: input.notes,
      paymentMethod: "card",
      shippingFee,
      subtotal,
      total,
      flaggedForReview: priorAbuseCount >= COD_ABUSE_THRESHOLD,
      items: { create: lineItems },
    },
    include: { items: true },
  });
}

// Mirrors modules/bookings/service.ts's attachPaymentIntent/getBookingByPaymentIntent
// pair — see BACKEND_CHANGES_MARKETPLACE_PAYMENTS.md.
export function attachPaymentIntent(orderId: string, stripePaymentIntentId: string) {
  return prisma.order.update({ where: { id: orderId }, data: { stripePaymentIntentId } });
}

export function getOrderByPaymentIntent(stripePaymentIntentId: string) {
  return prisma.order.findFirst({ where: { stripePaymentIntentId }, include: { items: true } });
}

// Called when the order row was created but Stripe PaymentIntent creation
// then failed, before the guest ever received a clientSecret — mirrors
// bookings' releasePendingBooking. Unlike a booking hold, a pending order
// doesn't reserve anything real yet (stock isn't decremented until
// confirmOrder runs), so there's no availability to free — just marks the
// otherwise-unpayable order cancelled instead of leaving a ghost "pending"
// row in the admin dashboard forever.
export async function releaseUnpaidOrder(orderId: string) {
  await prisma.order.updateMany({ where: { id: orderId, status: "pending" }, data: { status: "cancelled" } });
}

export function listOrders(status?: string) {
  return prisma.order.findMany({
    where: status ? { status: status as never } : {},
    include: { items: true },
    orderBy: { createdAt: "desc" },
  });
}

export function getOrder(id: string) {
  return prisma.order.findUnique({ where: { id }, include: { items: true } });
}

function assertInStock(name: string, onHand: number, wanted: number) {
  if (wanted <= onHand) return;
  throw ApiError.conflict(
    onHand <= 0
      ? `${name} is out of stock — please remove it from your cart.`
      : `Only ${onHand} × ${name} left — please update your cart.`
  );
}

// Decrements each line's stock only if enough is on hand (a conditional
// update, so two concurrent confirmations can't both take the last unit).
// Throws a 409 naming the product otherwise, rolling back the transaction.
async function takeStock(tx: Prisma.TransactionClient, items: { productId: string; quantity: number; productNameSnapshot: string }[]) {
  for (const item of items) {
    const taken = await tx.stockLevel.updateMany({
      where: { productId: item.productId, quantityOnHand: { gte: item.quantity } },
      data: { quantityOnHand: { decrement: item.quantity } },
    });
    if (taken.count === 0) {
      const level = await tx.stockLevel.findUnique({ where: { productId: item.productId } });
      assertInStock(item.productNameSnapshot, level?.quantityOnHand ?? 0, item.quantity);
    }
  }
}

// This is the point stock actually leaves inventory. Before
// BACKEND_CHANGES_MARKETPLACE_PAYMENTS.md it only ran when an admin phoned/
// verified a COD order; now it's normally driven by confirmOrderByPaymentIntent
// below (Stripe webhook, payment succeeded), and this stays reachable
// directly via PATCH /:id/status as a manual admin recovery path (e.g. the
// webhook was missed but Stripe's dashboard shows the charge went through).
export async function confirmOrder(orderId: string) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
  if (order.status !== "pending") throw ApiError.badRequest("Only pending orders can be confirmed");

  return prisma.$transaction(async (tx) => {
    await takeStock(tx, order.items);
    return tx.order.update({ where: { id: orderId }, data: { status: "confirmed" } });
  });
}

// Called from the Stripe webhook (payment_intent.succeeded) — mirrors
// bookings' confirmBooking(stripePaymentIntentId). Looks the order up by
// PaymentIntent id rather than trusting metadata.orderId alone, and reuses
// confirmOrder's transaction (decrement stock, mark confirmed) so there's
// only one place that logic lives. Returns { count: 0 } for a duplicate
// webhook delivery or a PaymentIntent that doesn't match any pending order
// (already confirmed, or the order was cancelled first) — same shape as
// confirmBooking's updateMany result, for the same reason: nothing to do,
// not an error.
//
// A paid order that can't be fulfilled — stock ran out between checkout and
// payment, or the order was cancelled (expired) before a late payment landed
// — is refunded in full automatically rather than backordered
// (BACKEND_CHANGES_SECURITY_AUDIT_FRONTEND.md C3/H2). An order that was
// cancelled but CAN still be fulfilled is reinstated instead.
export async function confirmOrderByPaymentIntent(
  stripePaymentIntentId: string
): Promise<"confirmed" | "refunded" | "refund_failed" | "nothing_to_do"> {
  const order = await prisma.order.findFirst({
    where: { stripePaymentIntentId },
    include: { items: true },
  });
  if (!order) return "nothing_to_do";
  const late = order.status === "cancelled" && !order.stripeRefundId;
  if (order.status !== "pending" && !late) return "nothing_to_do"; // duplicate delivery

  try {
    const done = await prisma.$transaction(async (tx) => {
      const flipped = await tx.order.updateMany({
        where: { id: order.id, status: order.status },
        data: { status: "confirmed" },
      });
      if (flipped.count === 0) return false; // a concurrent delivery got here first
      await takeStock(tx, order.items);
      return true;
    });
    return done ? "confirmed" : "nothing_to_do";
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    console.warn(`Paid order ${order.id} can't be fulfilled (${err.message}) — refunding`);
  }

  await prisma.order.updateMany({ where: { id: order.id, status: "pending" }, data: { status: "cancelled" } });
  const outcome = await refundOrder(order.id, stripePaymentIntentId, Number(order.total), `unfulfillable-order-${order.id}`);
  return outcome;
}

// Records the Stripe refund's outcome on the order rather than throwing —
// the status change that triggered it has already happened.
async function refundOrder(orderId: string, paymentIntentId: string, amount: number, idempotencyKey: string) {
  try {
    const refund = await refundPaymentIntent(MARKETPLACE_STRIPE_ACCOUNT, paymentIntentId, amount, idempotencyKey);
    await prisma.order.update({ where: { id: orderId }, data: { stripeRefundId: refund?.id ?? null, refundError: null } });
    return "refunded" as const;
  } catch (err) {
    console.error(`Refund failed for order ${orderId} (PaymentIntent ${paymentIntentId}):`, err);
    await prisma.order.update({ where: { id: orderId }, data: { refundError: (err as Error).message } });
    return "refund_failed" as const;
  }
}

const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["packed", "cancelled"],
  packed: ["shipped", "cancelled"],
  shipped: ["delivered", "returned"],
  delivered: ["returned"],
};

export async function updateOrderStatus(orderId: string, nextStatus: string) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });

  if (nextStatus === "confirmed") return confirmOrder(orderId);

  if (!VALID_TRANSITIONS[order.status]?.includes(nextStatus)) {
    throw ApiError.badRequest(`Cannot move order from ${order.status} to ${nextStatus}`);
  }

  // Restock if a confirmed-or-later order is cancelled/returned (stock had
  // already been decremented at confirmation).
  const shouldRestock =
    ["cancelled", "returned"].includes(nextStatus) && order.status !== "pending";

  const updated = await prisma.$transaction(async (tx) => {
    const flipped = await tx.order.updateMany({
      where: { id: orderId, status: order.status },
      data: { status: nextStatus as never },
    });
    if (flipped.count === 0) throw ApiError.conflict("This order was changed by someone else — reload and try again");
    if (shouldRestock) {
      for (const item of order.items) {
        await tx.stockLevel.update({
          where: { productId: item.productId },
          data: { quantityOnHand: { increment: item.quantity } },
        });
      }
    }
    return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
  });

  // Money side, after the status change has committed:
  // - a never-paid (pending) order being cancelled → make its PaymentIntent
  //   unpayable so the customer can't still pay for it;
  // - a paid order being cancelled/returned → full refund, outcome recorded
  //   on the order (refunded once only — idempotency key per order).
  if (order.stripePaymentIntentId && ["cancelled", "returned"].includes(nextStatus)) {
    if (order.status === "pending") {
      await cancelPaymentIntentQuietly(MARKETPLACE_STRIPE_ACCOUNT, order.stripePaymentIntentId);
    } else {
      await refundOrder(orderId, order.stripePaymentIntentId, Number(order.total), `refund-order-${orderId}`);
      return prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
    }
  }
  return updated;
}

// Cancels orders left "pending" (payment never completed — abandoned
// checkout, card declined and the customer left) past a generous window.
// Unlike a booking's pending_payment hold, nothing here blocks real
// inventory in the meantime (stock isn't decremented until confirmOrder
// runs), so this is just dashboard hygiene, not correctness-critical — a
// daily job is enough, no need for bookings' every-minute cadence. See
// BACKEND_CHANGES_MARKETPLACE_PAYMENTS.md point 4.
//
// Scoped to paymentMethod: "card" ONLY — a pre-existing "cod" order sitting
// in "pending" means something entirely different (the old COD flow: an
// order genuinely awaiting a staff phone call, which can legitimately sit
// there for a long time) and must never be auto-cancelled by this job. This
// was caught live: an early version without this filter auto-cancelled 3
// real, weeks-old "cod" pending orders in production during testing before
// this job was ever wired into cron — see the closing summary for
// BACKEND_CHANGES_MARKETPLACE_PAYMENTS.md/TESTIMONIALS.md for the incident
// and how it was reverted.
//
// Also cancels each order's PaymentIntent so it can't be paid after the fact
// (BACKEND_SECURITY_AUDIT.md H2); a payment that races in anyway is handled
// by confirmOrderByPaymentIntent's late-payment path.
export async function expireStalePendingOrders(olderThanHours = 24) {
  const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
  const where = { status: "pending" as const, paymentMethod: "card", createdAt: { lt: cutoff } };
  const stale = await prisma.order.findMany({ where, select: { id: true, stripePaymentIntentId: true } });
  if (stale.length === 0) return 0;

  const result = await prisma.order.updateMany({
    where: { ...where, id: { in: stale.map((o) => o.id) } },
    data: { status: "cancelled" },
  });
  for (const order of stale) {
    if (order.stripePaymentIntentId) {
      await cancelPaymentIntentQuietly(MARKETPLACE_STRIPE_ACCOUNT, order.stripePaymentIntentId);
    }
  }
  return result.count;
}
