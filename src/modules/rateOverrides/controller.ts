import { Request, Response } from "express";
import { ApiError } from "@/utils/ApiError";
import * as service from "./service";

export async function listRateOverrides(req: Request, res: Response) {
  res.json(await service.listRateOverrides(req.params.propertyId));
}

export async function createRateOverride(req: Request, res: Response) {
  res.status(201).json(await service.createRateOverride(req.params.propertyId, req.body));
}

// PATCH/DELETE are addressed by id, not propertyId, so the usual
// requirePropertyScope middleware can't scope these — fetch the row first
// and check here instead, same pattern as offers/controller.ts's assertScope.
function assertScope(req: Request, propertyId: string) {
  if (!req.admin) throw ApiError.unauthorized();
  if (req.admin.role === "super_admin") return;
  if (req.admin.role === "villa_manager" && req.admin.propertyScopeId === propertyId) return;
  throw ApiError.forbidden("Not scoped to this property");
}

export async function updateRateOverride(req: Request, res: Response) {
  const existing = await service.getRateOverride(req.params.id);
  if (!existing) throw ApiError.notFound("Rate override not found");
  assertScope(req, existing.propertyId);
  res.json(await service.updateRateOverride(req.params.id, req.body));
}

export async function deleteRateOverride(req: Request, res: Response) {
  const existing = await service.getRateOverride(req.params.id);
  if (!existing) throw ApiError.notFound("Rate override not found");
  assertScope(req, existing.propertyId);
  await service.deleteRateOverride(req.params.id);
  res.status(204).send();
}
