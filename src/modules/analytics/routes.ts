import { Router } from "express";
import rateLimit from "express-rate-limit";
import { asyncHandler } from "@/utils/asyncHandler";
import { requireAuth, requireRole } from "@/middleware/auth";
import * as controller from "./controller";

const router = Router();

// This backend had no rate-limiter anywhere before this endpoint — the only
// one public and high-volume enough to need one. 300/min/IP is generous
// headroom for a real visitor clicking/scrolling normally while still
// capping runaway abuse (scrapers, someone hammering it). Keyed on req.ip,
// which needs `app.set("trust proxy", ...)` (see app.ts) to reflect the
// real visitor behind Railway's proxy rather than the proxy's own address.
const clickEventsLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  // Same "never surface an error" rule as the handler itself — a client
  // that's over the limit still gets a 202, just silently ungenerated.
  handler: (_req, res) => res.status(202).end(),
});

// Public — hit directly by every visitor's browser (sendBeacon/fetch, not
// authedFetch), no admin/session context.
router.post("/click-events", clickEventsLimiter, asyncHandler(controller.recordClickEvents));

// Admin only — the heatmap viewer and its page-picker dropdown.
router.get(
  "/heatmap",
  requireAuth,
  requireRole("super_admin"),
  asyncHandler(controller.getHeatmapData)
);
router.get(
  "/heatmap/pages",
  requireAuth,
  requireRole("super_admin"),
  asyncHandler(controller.listHeatmapPages)
);

export default router;
