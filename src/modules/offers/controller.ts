import { Request, Response } from "express";
import { ApiError } from "@/utils/ApiError";
import * as service from "./service";

// PATCH/DELETE are addressed by offer id, not propertyId, so the usual
// requirePropertyScope("propertyId") middleware (which only looks at the
// route param / body) can't scope these — it has no way to know which
// property an arbitrary offer id belongs to. Fetch the offer first and
// check scope here instead, same principle as requirePropertyScope itself.
function assertScope(req: Request, propertyId: string) {
  if (!req.admin) throw ApiError.unauthorized();
  if (req.admin.role === "super_admin") return;
  if (req.admin.role === "villa_manager" && req.admin.propertyScopeId === propertyId) return;
  throw ApiError.forbidden("Not scoped to this property");
}

export async function listOffers(req: Request, res: Response) {
  const { propertyId } = req.query as { propertyId?: string };
  if (!propertyId) throw ApiError.badRequest("propertyId is required");
  res.json(await service.listOffers(propertyId));
}

export async function createOffer(req: Request, res: Response) {
  res.status(201).json(await service.createOffer(req.body));
}

export async function updateOffer(req: Request, res: Response) {
  const offer = await service.getOffer(req.params.id);
  if (!offer) throw ApiError.notFound("Offer not found");
  assertScope(req, offer.propertyId);
  res.json(await service.updateOffer(req.params.id, req.body));
}

export async function deleteOffer(req: Request, res: Response) {
  const offer = await service.getOffer(req.params.id);
  if (!offer) throw ApiError.notFound("Offer not found");
  assertScope(req, offer.propertyId);
  await service.deleteOffer(req.params.id);
  res.status(204).send();
}
