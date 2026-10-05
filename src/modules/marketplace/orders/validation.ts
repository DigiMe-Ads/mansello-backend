import { z } from "zod";

// Keep in sync with the frontend's MAX_CART_QUANTITY (cart-provider.tsx).
export const MAX_LINE_QUANTITY = 99;

// Public, unauthenticated checkout. Before this schema existed the body went
// straight into createOrder — negative or fractional quantities lowered the
// total (BACKEND_SECURITY_AUDIT.md C3). `shippingFee` may still be sent by the
// frontend but is stripped (unknown key) and never used: the fee is always
// computed server-side in computeShippingFee.
export const createOrderSchema = z.object({
  body: z.object({
    customerName: z.string().trim().min(1).max(120),
    customerPhone: z.string().trim().min(3).max(40),
    deliveryAddress: z.string().trim().min(1).max(500),
    notes: z.string().trim().max(1000).optional(),
    items: z
      .array(
        z.object({
          productId: z.string().uuid(),
          quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
        })
      )
      .min(1, "Your cart is empty")
      .max(50)
      .refine((items) => new Set(items.map((i) => i.productId)).size === items.length, {
        message: "Each product may appear only once",
      }),
  }),
});

export const updateOrderStatusSchema = z.object({
  body: z.object({
    status: z.enum(["confirmed", "packed", "shipped", "delivered", "cancelled", "returned"]),
  }),
});
