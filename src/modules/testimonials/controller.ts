import { Request, Response } from "express";
import { ApiError } from "@/utils/ApiError";
import * as service from "./service";

// Same path serves the public carousels and the admin Testimonials tab —
// branch on req.admin (set by optionalAuth in routes.ts, never required),
// same pattern as modules/blog/controller.ts listPosts. Public callers must
// pass `site`; an admin token can omit it to see both sites at once.
export async function listTestimonials(req: Request, res: Response) {
  const { site } = req.query as { site?: string };
  if (site !== undefined && site !== "italy" && site !== "sri_lanka") {
    throw ApiError.badRequest('site must be "italy" or "sri_lanka"');
  }
  const isAdmin = req.admin?.role === "super_admin";
  if (!isAdmin && !site) throw ApiError.badRequest("site is required");

  res.json(await service.listTestimonials({ site, includeInactive: isAdmin }));
}

export async function createTestimonial(req: Request, res: Response) {
  res.status(201).json(await service.createTestimonial(req.body));
}

export async function updateTestimonial(req: Request, res: Response) {
  res.json(await service.updateTestimonial(req.params.id, req.body));
}

export async function deleteTestimonial(req: Request, res: Response) {
  await service.deleteTestimonial(req.params.id);
  res.status(204).send();
}
