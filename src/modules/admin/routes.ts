import { Router } from "express";
import { asyncHandler } from "@/utils/asyncHandler";
import { requireAuth, requireRole } from "@/middleware/auth";
import * as controller from "./controller";

const router = Router();

router.post("/login", asyncHandler(controller.login));
router.post("/refresh", asyncHandler(controller.refresh));

router.get("/me", requireAuth, asyncHandler(controller.me));
router.get("/dashboard", requireAuth, asyncHandler(controller.getDashboard));

// Admin account management — super_admin only.
router.post("/users", requireAuth, requireRole("super_admin"), asyncHandler(controller.createAdminUser));
router.get("/users", requireAuth, requireRole("super_admin"), asyncHandler(controller.listAdminUsers));
router.delete("/users/:id", requireAuth, requireRole("super_admin"), asyncHandler(controller.deleteAdminUser));

export default router;
