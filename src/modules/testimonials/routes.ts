import { Router } from "express";
import { asyncHandler } from "@/utils/asyncHandler";
import { requireAuth, requireRole, optionalAuth } from "@/middleware/auth";
import { validate } from "@/middleware/validate";
import * as controller from "./controller";
import { createTestimonialSchema, updateTestimonialSchema } from "./validation";

const router = Router();

// Dual-purpose: anonymous callers must pass `site` and get active-only; a
// valid super_admin token can omit `site` and sees inactive rows too. See
// controller.listTestimonials.
router.get("/", optionalAuth, asyncHandler(controller.listTestimonials));

// Admin — super_admin only, same tier as Blog and Guest Info Form.
router.post(
  "/",
  requireAuth,
  requireRole("super_admin"),
  validate(createTestimonialSchema),
  asyncHandler(controller.createTestimonial)
);
router.patch(
  "/:id",
  requireAuth,
  requireRole("super_admin"),
  validate(updateTestimonialSchema),
  asyncHandler(controller.updateTestimonial)
);
router.delete("/:id", requireAuth, requireRole("super_admin"), asyncHandler(controller.deleteTestimonial));

export default router;
