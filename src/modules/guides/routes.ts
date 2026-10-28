import { Router } from "express";
import { asyncHandler } from "@/utils/asyncHandler";
import { requireAuth, requireRole } from "@/middleware/auth";
import { validate } from "@/middleware/validate";
import * as controller from "./controller";
import { getGuideSchema, putGuideSchema } from "./validation";

// Public read at /api/guides/:site, admin writes at /api/admin/guides/:site
// (same split as modules/content). super_admin only — this is public-facing
// copy, same tier as Content and Blog.

export const publicRoutes = Router();
publicRoutes.get("/:site", validate(getGuideSchema), asyncHandler(controller.getGuide));

export const adminRoutes = Router();
adminRoutes.put(
  "/:site",
  requireAuth,
  requireRole("super_admin"),
  validate(putGuideSchema),
  asyncHandler(controller.saveGuide)
);
adminRoutes.delete(
  "/:site",
  requireAuth,
  requireRole("super_admin"),
  validate(getGuideSchema),
  asyncHandler(controller.resetGuide)
);
