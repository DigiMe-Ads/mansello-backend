import { Router } from "express";
import multer from "multer";
import { asyncHandler } from "@/utils/asyncHandler";
import { requireAuth, requireRole } from "@/middleware/auth";
import * as controller from "./controller";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 10 }, // 5MB/file, 10 files/request
});

// Any admin role — not tied to one feature (offers, blog, and the
// marketplace catalog all use this).
router.post(
  "/images",
  requireAuth,
  requireRole("super_admin", "villa_manager", "marketplace_manager"),
  upload.array("images", 10),
  asyncHandler(controller.uploadImages)
);

export default router;
