import { Router } from "express";
import multer from "multer";
import { asyncHandler } from "@/utils/asyncHandler";
import { requireAuth, requireRole, optionalAuth } from "@/middleware/auth";
import { reviewLimiter } from "@/middleware/rateLimit";
import { validate } from "@/middleware/validate";
import {
  createCategorySchema,
  updateCategorySchema,
  createProductSchema,
  updateProductSchema,
  stockAdjustmentSchema,
  createVariantSchema,
  updateVariantSchema,
  setStockLevelSchema,
  createOfferSchema,
  updateOfferSchema,
} from "./validation";
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

// Public — product reviews (no auth). Reviews publish immediately; spam is
// removed with the admin DELETE below.
router.get("/products/:id/reviews", asyncHandler(controller.listReviews));
router.post("/products/:id/reviews", reviewLimiter, asyncHandler(controller.createReview));

// Admin — marketplace_manager or super_admin.
const manager = [requireAuth, requireRole("super_admin", "marketplace_manager")] as const;
router.post("/categories", ...manager, validate(createCategorySchema), asyncHandler(controller.createCategory));
router.patch("/categories/:id", ...manager, validate(updateCategorySchema), asyncHandler(controller.updateCategory));
router.delete("/categories/:id", ...manager, asyncHandler(controller.deleteCategory));
router.post("/products/images", ...manager, upload.array("images", 10), asyncHandler(controller.uploadProductImages));
router.post("/products", ...manager, validate(createProductSchema), asyncHandler(controller.createProduct));
router.patch("/products/:id", ...manager, validate(updateProductSchema), asyncHandler(controller.updateProduct));
router.delete("/products/:id", ...manager, asyncHandler(controller.deleteProduct));
router.post(
  "/products/:id/stock-adjustment",
  ...manager,
  validate(stockAdjustmentSchema),
  asyncHandler(controller.adjustStock)
);
router.get("/low-stock", ...manager, asyncHandler(controller.listLowStock));
router.get("/stock", ...manager, asyncHandler(controller.listStock));
router.patch("/stock/:id", ...manager, validate(setStockLevelSchema), asyncHandler(controller.setStockLevel));

// Admin — time-limited offers on products / their variations.
router.get("/offers", ...manager, asyncHandler(controller.listOffers));
router.post("/products/:id/offers", ...manager, validate(createOfferSchema), asyncHandler(controller.createOffer));
router.patch("/offers/:offerId", ...manager, validate(updateOfferSchema), asyncHandler(controller.updateOffer));
router.delete("/offers/:offerId", ...manager, asyncHandler(controller.deleteOffer));

// Admin — product variations (BACKEND_CHANGES_VARIANTS_CALENDAR_PAYMENTS_LK.md §1).
router.post("/products/:id/variants", ...manager, validate(createVariantSchema), asyncHandler(controller.createVariant));
router.patch(
  "/products/:id/variants/:variantId",
  ...manager,
  validate(updateVariantSchema),
  asyncHandler(controller.updateVariant)
);
router.delete("/products/:id/variants/:variantId", ...manager, asyncHandler(controller.deleteVariant));
router.post(
  "/products/:id/variants/:variantId/stock-adjustment",
  ...manager,
  validate(stockAdjustmentSchema),
  asyncHandler(controller.adjustVariantStock)
);
router.delete("/reviews/:id", ...manager, asyncHandler(controller.deleteReview));

export default router;
