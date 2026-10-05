import { Router } from "express";
import { asyncHandler } from "@/utils/asyncHandler";
import { requireAuth, requireRole } from "@/middleware/auth";
import { loginLimiter } from "@/middleware/rateLimit";
import { validate } from "@/middleware/validate";
import { createAdminUserSchema } from "./validation";
import * as controller from "./controller";

const router = Router();

router.post("/login", loginLimiter, asyncHandler(controller.login));
router.post("/refresh", asyncHandler(controller.refresh));
router.post("/logout", requireAuth, asyncHandler(controller.logout));

router.get("/me", requireAuth, asyncHandler(controller.me));
router.get("/dashboard", requireAuth, asyncHandler(controller.getDashboard));

// Admin account management — super_admin only.
router.post(
  "/users",
  requireAuth,
  requireRole("super_admin"),
  validate(createAdminUserSchema),
  asyncHandler(controller.createAdminUser)
);
router.get("/users", requireAuth, requireRole("super_admin"), asyncHandler(controller.listAdminUsers));
router.delete("/users/:id", requireAuth, requireRole("super_admin"), asyncHandler(controller.deleteAdminUser));

export default router;
