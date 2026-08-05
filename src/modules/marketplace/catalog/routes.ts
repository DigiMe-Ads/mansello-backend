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

// Public — storefront.
router.get("/categories", asyncHandler(controller.listCategories));
router.get("/products", asyncHandler(controller.listProducts));
router.get("/products/:id", asyncHandler(controller.getProduct));

// Admin — marketplace_manager or super_admin.
const manager = [requireAuth, requireRole("super_admin", "marketplace_manager")] as const;
router.post("/categories", ...manager, asyncHandler(controller.createCategory));
router.post("/products/images", ...manager, upload.array("images", 10), asyncHandler(controller.uploadProductImages));
router.post("/products", ...manager, asyncHandler(controller.createProduct));
router.patch("/products/:id", ...manager, asyncHandler(controller.updateProduct));
router.post("/products/:id/stock-adjustment", ...manager, asyncHandler(controller.adjustStock));
router.get("/low-stock", ...manager, asyncHandler(controller.listLowStock));

export default router;
