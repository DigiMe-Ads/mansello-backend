import { Router } from "express";
import { asyncHandler } from "@/utils/asyncHandler";
import { requireAuth, requireRole, requirePropertyScope, optionalAuth } from "@/middleware/auth";
import * as controller from "./controller";

const router = Router();

// Public — powers the read-only booking calendar on the frontend. An admin
// token (the Calendar & Blocks tab sends one) gets the full rows.
router.get("/:propertyId", optionalAuth, asyncHandler(controller.listBlocks));

// Admin — manual blocking (maintenance, personal use).
router.post(
  "/:propertyId/blocks",
  requireAuth,
  requireRole("super_admin", "villa_manager"),
  requirePropertyScope("propertyId"),
  asyncHandler(controller.createManualBlock)
);
router.delete(
  "/blocks/:blockId",
  requireAuth,
  requireRole("super_admin", "villa_manager"),
  asyncHandler(controller.releaseBlock)
);

export default router;
