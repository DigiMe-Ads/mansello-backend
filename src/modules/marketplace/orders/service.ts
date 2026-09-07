import { prisma } from "@/db/prisma";
import { ApiError } from "@/utils/ApiError";
import { computeShippingFee } from "@/modules/marketplace/shipping/service";

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
  });
  if (products.length !== input.items.length) {
    throw ApiError.badRequest("One or more products are unavailable");
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
    for (const item of order.items) {
      await tx.stockLevel.update({
        where: { productId: item.productId },
        data: { quantityOnHand: { decrement: item.quantity } },
      });
    }
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
export async function confirmOrderByPaymentIntent(stripePaymentIntentId: string) {
  const order = await prisma.order.findFirst({
    where: { stripePaymentIntentId, status: "pending" },
  });
  if (!order) return { count: 0 };
  await confirmOrder(order.id);
  return { count: 1 };
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

  return prisma.$transaction(async (tx) => {
    if (shouldRestock) {
      for (const item of order.items) {
        await tx.stockLevel.update({
          where: { productId: item.productId },
          data: { quantityOnHand: { increment: item.quantity } },
        });
      }
    }
    return tx.order.update({ where: { id: orderId }, data: { status: nextStatus as never } });
  });
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
export async function expireStalePendingOrders(olderThanHours = 24) {
  const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
  const result = await prisma.order.updateMany({
    where: { status: "pending", paymentMethod: "card", createdAt: { lt: cutoff } },
    data: { status: "cancelled" },
  });
  return result.count;
}
