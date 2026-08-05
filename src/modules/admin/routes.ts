import { Router } from "express";
import { asyncHandler } from "@/utils/asyncHandler";
import { requireAuth, requireRole } from "@/middleware/auth";
import * as controller from "./controller";

const router = Router();

router.post("/login", asyncHandler(controller.login));
router.post("/refresh", asyncHandler(controller.refresh));

router.get("/me", requireAuth, asyncHandler(controller.me));
router.get("/dashboard", requireAuth, asyncHandler(controller.getDashboard));

// Only super_admin can create new admin accounts.
router.post("/users", requireAuth, requireRole("super_admin"), asyncHandler(controller.createAdminUser));

export default router;
