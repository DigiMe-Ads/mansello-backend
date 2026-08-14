import { Router } from "express";
import multer from "multer";
import { asyncHandler } from "@/utils/asyncHandler";
import { requireAuth, requireRole, optionalAuth } from "@/middleware/auth";
import * as controller from "./controller";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 10 }, // 5MB/file, 10 files/request
});

// Public — storefront. Dual-purpose on the two product routes: anonymous
// callers get active-only (unchanged), a valid super_admin/marketplace_manager
// token also includes inactive products — same pattern as blog's listPosts
// (API_DOCUMENTATION.md §10), so the admin panel can find a deactivated
// product to reassign or delete it.
router.get("/categories", asyncHandler(controller.listCategories));
router.get("/products", optionalAuth, asyncHandler(controller.listProducts));
router.get("/products/:id", optionalAuth, asyncHandler(controller.getProduct));

// Admin — marketplace_manager or super_admin.
const manager = [requireAuth, requireRole("super_admin", "marketplace_manager")] as const;
router.post("/categories", ...manager, asyncHandler(controller.createCategory));
router.delete("/categories/:id", ...manager, asyncHandler(controller.deleteCategory));
router.post("/products/images", ...manager, upload.array("images", 10), asyncHandler(controller.uploadProductImages));
router.post("/products", ...manager, asyncHandler(controller.createProduct));
router.patch("/products/:id", ...manager, asyncHandler(controller.updateProduct));
router.delete("/products/:id", ...manager, asyncHandler(controller.deleteProduct));
router.post("/products/:id/stock-adjustment", ...manager, asyncHandler(controller.adjustStock));
router.get("/low-stock", ...manager, asyncHandler(controller.listLowStock));

export default router;
