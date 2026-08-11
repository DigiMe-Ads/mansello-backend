import { Request, Response } from "express";
import { ApiError } from "@/utils/ApiError";
import * as bookingService from "@/modules/bookings/service";
import { uploadDocument } from "@/modules/uploads/imageUpload";
import * as service from "./service";

// Admin — shared question-list template (Settings).
export async function getTemplate(_req: Request, res: Response) {
  res.json(await service.getGuestInfoTemplate());
}

export async function updateTemplate(req: Request, res: Response) {
  res.json(await service.updateGuestInfoTemplate(req.body.fields));
}

// Admin — per-booking requests. propertyId isn't in these routes' params/body
// (only the bookingId is), so the usual requirePropertyScope middleware can't
// scope them — fetch the booking first and check here instead, same pattern
// as modules/offers/controller.ts's assertScope.
function assertBookingScope(req: Request, propertyId: string) {
  if (!req.admin) throw ApiError.unauthorized();
  if (req.admin.role === "super_admin") return;
  if (req.admin.role === "villa_manager" && req.admin.propertyScopeId === propertyId) return;
  throw ApiError.forbidden("Not scoped to this property");
}

export async function createBookingInfoRequest(req: Request, res: Response) {
  const booking = await bookingService.getBooking(req.params.id);
  if (!booking) throw ApiError.notFound("Booking not found");
  assertBookingScope(req, booking.propertyId);
  res.status(201).json(await service.createBookingInfoRequest(booking));
}

export async function listBookingInfoRequests(req: Request, res: Response) {
  const booking = await bookingService.getBooking(req.params.id);
  if (!booking) throw ApiError.notFound("Booking not found");
  assertBookingScope(req, booking.propertyId);
  res.json(await service.listBookingInfoRequests(req.params.id));
}

// Public — the guest-facing link, no auth.
export async function getByToken(req: Request, res: Response) {
  res.json(await service.getBookingInfoRequestByToken(req.params.token));
}

export async function submitByToken(req: Request, res: Response) {
  res.json(await service.submitBookingInfoRequest(req.params.token, req.body.answers));
}

// Uploaded as the guest fills the form (one call per file-selection, not
// bundled into the final submit payload) — same token/status gating as
// submit, checked before touching S3 so a dead link can't be used to fill
// a bucket.
export async function uploadFiles(req: Request, res: Response) {
  await service.assertUploadable(req.params.token);

  const files = req.files as Express.Multer.File[] | undefined;
  if (!files?.length) throw ApiError.badRequest('No files uploaded (field name must be "files")');

  const urls = await Promise.all(files.map((file) => uploadDocument(file)));
  res.status(201).json({ urls });
}
