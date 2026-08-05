import { prisma } from "@/db/prisma";
import { ApiError } from "@/utils/ApiError";

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
  shippingFee: number;
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
  const total = subtotal + input.shippingFee;

  const priorAbuseCount = await prisma.order.count({
    where: { customerPhone: input.customerPhone, status: { in: ["cancelled", "returned"] } },
  });

  return prisma.order.create({
    data: {
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      deliveryAddress: input.deliveryAddress,
      notes: input.notes,
      paymentMethod: "cod",
      shippingFee: input.shippingFee,
      subtotal,
      total,
      flaggedForReview: priorAbuseCount >= COD_ABUSE_THRESHOLD,
      items: { create: lineItems },
    },
    include: { items: true },
  });
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

// Admin confirms after phoning/verifying the order — this is the point stock
// actually leaves inventory for a COD storefront (no payment capture event
// to hang it off of instead).
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
