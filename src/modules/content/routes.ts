import { Router } from "express";
import { asyncHandler } from "@/utils/asyncHandler";
import { requireAuth, requireRole } from "@/middleware/auth";
import { validate } from "@/middleware/validate";
import * as controller from "./controller";
import { putContentSchema, deleteContentSchema } from "./validation";

// Two separately-mounted routers (see app.ts) — public GET lives at
// /api/content, admin writes at /api/admin/content, per
// BACKEND_CHANGES_SITE_CONTENT.md.

export const publicRoutes = Router();
publicRoutes.get("/", asyncHandler(controller.getContent));

// super_admin only, enforced here server-side — the frontend's own
// RequireAdmin gate reads a role out of localStorage and is trivially
// bypassed (BACKEND_CHANGES_SEO_SECURITY_HARDENING.md §6.1), and this
// endpoint rewrites what every visitor to the site reads, so it's a
// defacement vector if the role isn't verified against the JWT here.
export const adminRoutes = Router();
adminRoutes.put(
  "/",
  requireAuth,
  requireRole("super_admin"),
  validate(putContentSchema),
  asyncHandler(controller.putContent)
);
adminRoutes.delete(
  "/",
  requireAuth,
  requireRole("super_admin"),
  validate(deleteContentSchema),
  asyncHandler(controller.deleteContent)
);
