import { Router } from "express";
import { asyncHandler } from "@/utils/asyncHandler";
import { requireAuth, requireRole, requirePropertyScope, optionalAuth } from "@/middleware/auth";
import { validate } from "@/middleware/validate";
import * as controller from "./controller";
import { createRoomSchema, updateRoomSchema } from "./validation";

// Two separately-mounted routers (see app.ts) — same approach as
// modules/guestInfo/routes.ts, because these two surfaces don't share a
// path prefix: nested-under-property (list/create) vs addressed directly
// by room id (update/delete).

// Mounted at /api/properties — adds /:propertyId/rooms alongside the
// existing properties router. Public list (optionalAuth: an admin token
// scoped to this property additionally sees inactive rooms via
// ?includeInactive=true — same branch-on-token pattern as blog's
// listPosts, API_DOCUMENTATION.md §10), admin-only create.
export const propertyRoomsRoutes = Router();
propertyRoomsRoutes.get("/:propertyId/rooms", optionalAuth, asyncHandler(controller.listRooms));
propertyRoomsRoutes.post(
  "/:propertyId/rooms",
  requireAuth,
  requireRole("super_admin", "villa_manager"),
  requirePropertyScope("propertyId"),
  validate(createRoomSchema),
  asyncHandler(controller.createRoom)
);

// Mounted at /api/rooms — addressed by roomId, not propertyId, so scope is
// resolved in the controller after fetching the room (see assertScope
// there).
export const roomRoutes = Router();
roomRoutes.patch(
  "/:roomId",
  requireAuth,
  requireRole("super_admin", "villa_manager"),
  validate(updateRoomSchema),
  asyncHandler(controller.updateRoom)
);
roomRoutes.delete(
  "/:roomId",
  requireAuth,
  requireRole("super_admin", "villa_manager"),
  asyncHandler(controller.deleteRoom)
);
