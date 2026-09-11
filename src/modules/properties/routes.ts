import { Router } from "express";
import { asyncHandler } from "@/utils/asyncHandler";
import { requireAuth, requireRole, requirePropertyScope } from "@/middleware/auth";
import { validate } from "@/middleware/validate";
import * as controller from "./controller";
import { updatePropertySchema } from "./validation";

const router = Router();

// Public — used by the marketing/booking frontend.
router.get("/", asyncHandler(controller.listProperties));
router.get("/:slug", asyncHandler(controller.getProperty));

// Admin — villa_manager scoped to their own property, super_admin unrestricted.
router.patch(
  "/:propertyId",
  requireAuth,
  requireRole("super_admin", "villa_manager"),
  requirePropertyScope("propertyId"),
  validate(updatePropertySchema),
  asyncHandler(controller.updateProperty)
);
router.put(
  "/:propertyId/pricing-tiers",
  requireAuth,
  requireRole("super_admin", "villa_manager"),
  requirePropertyScope("propertyId"),
  asyncHandler(controller.updatePricingTiers)
);
router.delete(
  "/:propertyId/pricing-tiers/:tierId",
  requireAuth,
  requireRole("super_admin", "villa_manager"),
  requirePropertyScope("propertyId"),
  asyncHandler(controller.deletePricingTier)
);

export default router;
