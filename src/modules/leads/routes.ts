import { Router } from "express";
import { asyncHandler } from "@/utils/asyncHandler";
import { requireAuth, requireRole } from "@/middleware/auth";
import { validate } from "@/middleware/validate";
import * as controller from "./controller";
import { subscribeNewsletterSchema } from "./validation";

const router = Router();

// Public — contact form + transport quote request (shared by both sites).
router.post("/contact", asyncHandler(controller.createContactMessage));
router.post("/transport-requests", asyncHandler(controller.createTransportRequest));
router.post(
  "/newsletter",
  validate(subscribeNewsletterSchema),
  asyncHandler(controller.subscribeToNewsletter)
);

// Admin inbox — any admin role can read leads.
const admin = [requireAuth, requireRole("super_admin", "villa_manager", "marketplace_manager")] as const;
router.get("/contact", ...admin, asyncHandler(controller.listContactMessages));
router.patch("/contact/:id/status", ...admin, asyncHandler(controller.updateContactMessageStatus));
router.get("/transport-requests", ...admin, asyncHandler(controller.listTransportRequests));
router.patch("/transport-requests/:id/status", ...admin, asyncHandler(controller.updateTransportRequestStatus));
router.get("/newsletter", ...admin, asyncHandler(controller.listNewsletterSubscribers));

export default router;
