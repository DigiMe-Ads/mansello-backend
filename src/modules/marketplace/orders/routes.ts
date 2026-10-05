import { Router } from "express";
import { asyncHandler } from "@/utils/asyncHandler";
import { requireAuth, requireRole } from "@/middleware/auth";
import { publicFormLimiter } from "@/middleware/rateLimit";
import { validate } from "@/middleware/validate";
import { createOrderSchema, updateOrderStatusSchema } from "./validation";
import * as controller from "./controller";

const router = Router();

// Public — guest checkout.
router.post("/", publicFormLimiter, validate(createOrderSchema), asyncHandler(controller.createOrder));
router.get("/:id", asyncHandler(controller.getOrder));

// Admin.
const manager = [requireAuth, requireRole("super_admin", "marketplace_manager")] as const;
router.get("/", ...manager, asyncHandler(controller.listOrders));
router.patch("/:id/status", ...manager, validate(updateOrderStatusSchema), asyncHandler(controller.updateOrderStatus));

export default router;
