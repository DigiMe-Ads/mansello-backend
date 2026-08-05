import { Router } from "express";
import { asyncHandler } from "@/utils/asyncHandler";
import { requireAuth, requireRole } from "@/middleware/auth";
import * as controller from "./controller";

const router = Router();

// Public — guest COD checkout.
router.post("/", asyncHandler(controller.createOrder));
router.get("/:id", asyncHandler(controller.getOrder));

// Admin.
const manager = [requireAuth, requireRole("super_admin", "marketplace_manager")] as const;
router.get("/", ...manager, asyncHandler(controller.listOrders));
router.patch("/:id/status", ...manager, asyncHandler(controller.updateOrderStatus));

export default router;
