import { Router } from "express";
import multer from "multer";
import { asyncHandler } from "@/utils/asyncHandler";
import { requireAuth, requireRole } from "@/middleware/auth";
import { validate } from "@/middleware/validate";
import * as controller from "./controller";
import { updateGuestInfoTemplateSchema, submitBookingInfoRequestSchema } from "./validation";

// Larger than the admin image-upload cap (5MB) since PDFs are allowed here.
const uploadDocuments = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
});

// Three separately-mounted routers (see app.ts) — same approach as
// modules/payments/webhooks.ts exporting more than one router from one file
// — because this feature's three surfaces don't share a path prefix:
// admin settings, admin per-booking, and the public token-gated link.

// Admin — shared question-list template. super_admin only: shared across
// both properties, same reasoning as Blog (API_DOCUMENTATION.md §10).
// Mounted at /api/admin/guest-info-template.
export const templateRoutes = Router();
templateRoutes.get("/", requireAuth, requireRole("super_admin"), asyncHandler(controller.getTemplate));
templateRoutes.put(
  "/",
  requireAuth,
  requireRole("super_admin"),
  validate(updateGuestInfoTemplateSchema),
  asyncHandler(controller.updateTemplate)
);

// Admin — per-booking requests. Mounted at /api/bookings, alongside (but
// separate from) the existing bookings router.
export const bookingRoutes = Router();
bookingRoutes.post(
  "/:id/info-requests",
  requireAuth,
  requireRole("super_admin", "villa_manager"),
  asyncHandler(controller.createBookingInfoRequest)
);
bookingRoutes.get(
  "/:id/info-requests",
  requireAuth,
  requireRole("super_admin", "villa_manager"),
  asyncHandler(controller.listBookingInfoRequests)
);

// Public — the guest-facing link, no auth. Knowing the token is the access
// control (same trust model as Property.icalExportToken). Mounted at
// /api/booking-info-requests.
export const publicRoutes = Router();
publicRoutes.get("/:token", asyncHandler(controller.getByToken));
publicRoutes.post(
  "/:token/submit",
  validate(submitBookingInfoRequestSchema),
  asyncHandler(controller.submitByToken)
);
// Immediate upload on file selection, before submit — files under a
// repeatable "files" field. JPEG/PNG/WebP/PDF only, 10MB/file — enforced in
// modules/uploads/imageUpload.ts's uploadDocument, not just the frontend's
// <input accept>.
publicRoutes.post(
  "/:token/uploads",
  uploadDocuments.array("files", 10),
  asyncHandler(controller.uploadFiles)
);
