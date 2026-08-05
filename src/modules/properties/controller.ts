import { Request, Response } from "express";
import { ApiError } from "@/utils/ApiError";
import * as service from "./service";

export async function listProperties(_req: Request, res: Response) {
  res.json(await service.listProperties());
}

export async function getProperty(req: Request, res: Response) {
  const property = await service.getPropertyBySlug(req.params.slug);
  if (!property) throw ApiError.notFound("Property not found");
  res.json(property);
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
