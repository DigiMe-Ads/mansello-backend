import { Router } from "express";
import { asyncHandler } from "@/utils/asyncHandler";
import { requireAuth, requireRole, optionalAuth } from "@/middleware/auth";
import { validate } from "@/middleware/validate";
import * as controller from "./controller";
import { createPostSchema, updatePostSchema } from "./validation";

const router = Router();

// Dual-purpose: anonymous callers get published-only; a valid super_admin
// token gets drafts too and can omit `site`. See controller.listPosts.
router.get("/posts", optionalAuth, asyncHandler(controller.listPosts));
router.get("/posts/:slug", asyncHandler(controller.getPostBySlug));

// Admin — deliberately super_admin only (posts aren't scoped to one
// property or the marketplace the way villa_manager/marketplace_manager are).
router.post(
  "/posts",
  requireAuth,
  requireRole("super_admin"),
  validate(createPostSchema),
  asyncHandler(controller.createPost)
);
router.patch(
  "/posts/:id",
  requireAuth,
  requireRole("super_admin"),
  validate(updatePostSchema),
  asyncHandler(controller.updatePost)
);
router.delete("/posts/:id", requireAuth, requireRole("super_admin"), asyncHandler(controller.deletePost));

export default router;
