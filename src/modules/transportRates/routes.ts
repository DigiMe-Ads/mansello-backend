import { Router } from "express";
import { asyncHandler } from "@/utils/asyncHandler";
import { requireAuth, requireRole, requirePropertyScope } from "@/middleware/auth";
import { validate } from "@/middleware/validate";
import * as controller from "./controller";
import { replaceTransportRatesSchema } from "./validation";

// Two separately-mounted routers (see app.ts) — same approach as
// modules/rooms/routes.ts and modules/rateOverrides/routes.ts, because the
// public and admin surfaces here don't share a path prefix. The admin one
// is deliberately mounted at /api/admin/properties (not /api/properties,
// where every other property-scoped admin route — pricing-tiers included —
// lives) to match the exact path BACKEND_CHANGES_VILLA_TRANSPORT.md's
// already-shipped frontend module expects.

// Public — guests need the price before they book.
export const propertyTransportRatesRoutes = Router();
propertyTransportRatesRoutes.get(
  "/:propertyId/transport-rates",
  asyncHandler(controller.listTransportRates)
);

// Admin.
export const adminTransportRatesRoutes = Router();
adminTransportRatesRoutes.put(
  "/:propertyId/transport-rates",
  requireAuth,
  requireRole("super_admin", "villa_manager"),
  requirePropertyScope("propertyId"),
  validate(replaceTransportRatesSchema),
  asyncHandler(controller.replaceTransportRates)
);
