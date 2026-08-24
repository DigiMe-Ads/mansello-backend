import { Router } from "express";
import { asyncHandler } from "@/utils/asyncHandler";
import { requireAuth, requireRole, requirePropertyScope } from "@/middleware/auth";
import { validate } from "@/middleware/validate";
import * as controller from "./controller";
import { createRateOverrideSchema, updateRateOverrideSchema } from "./validation";

// Two separately-mounted routers (see app.ts) — same approach as
// modules/rooms/routes.ts, since these two surfaces don't share a path
// prefix: nested-under-property (list/create) vs addressed directly by id.

// Mounted at /api/properties — adds /:propertyId/rate-overrides.
export const propertyRateOverrideRoutes = Router();
propertyRateOverrideRoutes.get(
  "/:propertyId/rate-overrides",
  asyncHandler(controller.listRateOverrides)
);
propertyRateOverrideRoutes.post(
  "/:propertyId/rate-overrides",
  requireAuth,
  requireRole("super_admin", "villa_manager"),
  requirePropertyScope("propertyId"),
  validate(createRateOverrideSchema),
  asyncHandler(controller.createRateOverride)
);

// Mounted at /api/rate-overrides — addressed by id, not propertyId, so
// scope is resolved in the controller after fetching the row.
export const rateOverrideRoutes = Router();
rateOverrideRoutes.patch(
  "/:id",
  requireAuth,
  requireRole("super_admin", "villa_manager"),
  validate(updateRateOverrideSchema),
  asyncHandler(controller.updateRateOverride)
);
rateOverrideRoutes.delete(
  "/:id",
  requireAuth,
  requireRole("super_admin", "villa_manager"),
  asyncHandler(controller.deleteRateOverride)
);
