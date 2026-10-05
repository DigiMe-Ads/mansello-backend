import { Request, Response } from "express";
import { ApiError } from "@/utils/ApiError";
import { canAccessProperty } from "@/middleware/auth";
import * as service from "./service";

// The iCal secrets — our export feed token, each channel's import URL (it
// embeds that channel's own secret token) and the per-URL sync status
// (repeats the URLs). Only an admin scoped to the property gets them
// (optionalAuth in routes.ts); everyone else gets the property without them.
// See BACKEND_SECURITY_AUDIT.md H1.
function forCaller<T extends { id: string; icalExportToken: string; airbnbIcalImportUrls: string[]; icalImportStatus: unknown }>(
  req: Request,
  property: T
) {
  if (canAccessProperty(req.admin, property.id)) return property;
  const { icalExportToken: _t, airbnbIcalImportUrls: _u, icalImportStatus: _s, ...rest } = property;
  return rest;
}

export async function listProperties(req: Request, res: Response) {
  const properties = await service.listProperties();
  res.json(properties.map((p) => forCaller(req, p)));
}

export async function getProperty(req: Request, res: Response) {
  const property = await service.getPropertyBySlug(req.params.slug);
  if (!property) throw ApiError.notFound("Property not found");
  res.json(forCaller(req, property));
}

export async function updatePricingTiers(req: Request, res: Response) {
  await service.updatePricingTiers(req.params.propertyId, req.body.tiers);
  res.json(await service.getPropertyById(req.params.propertyId));
}

export async function deletePricingTier(req: Request, res: Response) {
  await service.deletePricingTier(req.params.propertyId, req.params.tierId);
  res.status(204).send();
}

export async function updateProperty(req: Request, res: Response) {
  res.json(await service.updateProperty(req.params.propertyId, req.body));
}
