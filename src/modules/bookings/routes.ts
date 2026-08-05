import { Router } from "express";
import { asyncHandler } from "@/utils/asyncHandler";
import { requireAuth, requireRole, requirePropertyScope } from "@/middleware/auth";
import { validate } from "@/middleware/validate";
import * as controller from "./controller";
import { startBookingSchema, offlineBookingSchema, cancelBookingSchema } from "./validation";

const router = Router();

// Public — guest checkout.
router.post("/", validate(startBookingSchema), asyncHandler(controller.startBooking));
router.get("/:id", asyncHandler(controller.getBooking));

// Admin.
router.get(
  "/property/:propertyId",
  requireAuth,
  requireRole("super_admin", "villa_manager"),
  requirePropertyScope("propertyId"),
  asyncHandler(controller.listBookings)
);
router.post(
  "/offline",
  requireAuth,
  requireRole("super_admin", "villa_manager"),
  requirePropertyScope("propertyId"),
  validate(offlineBookingSchema),
  asyncHandler(controller.createOfflineBooking)
);
router.post(
  "/:id/cancel",
  requireAuth,
  requireRole("super_admin", "villa_manager"),
  validate(cancelBookingSchema),
  asyncHandler(controller.cancelBooking)
);

export default router;
