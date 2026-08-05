import { Router } from "express";
import { asyncHandler } from "@/utils/asyncHandler";
import { requireAuth, requireRole, requirePropertyScope } from "@/middleware/auth";
import { validate } from "@/middleware/validate";
import * as controller from "./controller";
import { createOfferSchema, updateOfferSchema } from "./validation";

const router = Router();

// Public — homepage deal card.
router.get("/", asyncHandler(controller.listOffers));

// Admin — villa_manager scoped to their own property, super_admin unrestricted.
router.post(
  "/",
  requireAuth,
  requireRole("super_admin", "villa_manager"),
  requirePropertyScope("propertyId"),
  validate(createOfferSchema),
  asyncHandler(controller.createOffer)
);
// PATCH/DELETE scope-check which property an offer belongs to inside the
// controller itself (see offers/controller.ts) rather than via
// requirePropertyScope, since propertyId isn't in these routes' params/body.
router.patch(
  "/:id",
  requireAuth,
  requireRole("super_admin", "villa_manager"),
  validate(updateOfferSchema),
  asyncHandler(controller.updateOffer)
);
router.delete(
  "/:id",
  requireAuth,
  requireRole("super_admin", "villa_manager"),
  asyncHandler(controller.deleteOffer)
);

export default router;
