import { Router } from "express";
import { asyncHandler } from "@/utils/asyncHandler";
import { requireAuth, requireRole } from "@/middleware/auth";
import { validate } from "@/middleware/validate";
import * as controller from "./controller";
import { replaceShippingRatesSchema } from "./validation";

const router = Router();

// Public — checkout needs to price shipping before the customer has any session.
router.get("/", asyncHandler(controller.listShippingRates));

router.put(
  "/",
  requireAuth,
  requireRole("super_admin", "marketplace_manager"),
  validate(replaceShippingRatesSchema),
  asyncHandler(controller.replaceShippingRates)
);

export default router;
