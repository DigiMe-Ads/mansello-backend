import { Router } from "express";
import { asyncHandler } from "@/utils/asyncHandler";
import { requireAuth, requireRole } from "@/middleware/auth";
import { validate } from "@/middleware/validate";
import { publicFormLimiter } from "@/middleware/rateLimit";
import * as controller from "./controller";
import {
  subscribeNewsletterSchema,
  createCustomOrderRequestSchema,
  createContactMessageSchema,
  createTransportRequestSchema,
  updateLeadStatusSchema,
} from "./validation";

const router = Router();

// Public — contact form + transport quote request (shared by both sites).
router.post("/contact", publicFormLimiter, validate(createContactMessageSchema), asyncHandler(controller.createContactMessage));
router.post(
  "/transport-requests",
  publicFormLimiter,
  validate(createTransportRequestSchema),
  asyncHandler(controller.createTransportRequest)
);
router.post(
  "/newsletter",
  publicFormLimiter,
  validate(subscribeNewsletterSchema),
  asyncHandler(controller.subscribeToNewsletter)
);
router.post(
  "/custom-orders",
  publicFormLimiter,
  validate(createCustomOrderRequestSchema),
  asyncHandler(controller.createCustomOrderRequest)
);

// Admin inbox — any admin role can read leads.
const admin = [requireAuth, requireRole("super_admin", "villa_manager", "marketplace_manager")] as const;
router.get("/contact", ...admin, asyncHandler(controller.listContactMessages));
router.patch("/contact/:id/status", ...admin, validate(updateLeadStatusSchema), asyncHandler(controller.updateContactMessageStatus));
router.get("/transport-requests", ...admin, asyncHandler(controller.listTransportRequests));
router.patch(
  "/transport-requests/:id/status",
  ...admin,
  validate(updateLeadStatusSchema),
  asyncHandler(controller.updateTransportRequestStatus)
);
router.get("/newsletter", ...admin, asyncHandler(controller.listNewsletterSubscribers));

// Marketplace-only inbox — unlike the general leads above, custom order
// requests are marketplace-specific, so villa_manager is deliberately
// excluded (matches the same scoping as orders/shipping-rates).
const marketplaceAdmin = [requireAuth, requireRole("super_admin", "marketplace_manager")] as const;
router.get("/custom-orders", ...marketplaceAdmin, asyncHandler(controller.listCustomOrderRequests));
router.patch(
  "/custom-orders/:id/status",
  ...marketplaceAdmin,
  validate(updateLeadStatusSchema),
  asyncHandler(controller.updateCustomOrderRequestStatus)
);

export default router;
