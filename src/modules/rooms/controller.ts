import { Request, Response } from "express";
import { ApiError } from "@/utils/ApiError";
import * as service from "./service";

// Populated by optionalAuth in routes.ts — never required for the list
// endpoint, just read if present. Mirrors blog's listPosts admin branch.
function isRoomsAdmin(req: Request, propertyId: string) {
  if (!req.admin) return false;
  if (req.admin.role === "super_admin") return true;
  return req.admin.role === "villa_manager" && req.admin.propertyScopeId === propertyId;
}

export async function listRooms(req: Request, res: Response) {
  const includeInactive =
    req.query.includeInactive === "true" && isRoomsAdmin(req, req.params.propertyId);
  res.json(await service.listRooms(req.params.propertyId, includeInactive));
}

export async function createRoom(req: Request, res: Response) {
  res.status(201).json(await service.createRoom(req.params.propertyId, req.body));
}

// PATCH/DELETE are addressed by roomId, not propertyId, so the usual
// requirePropertyScope middleware (route-param-only) can't scope these —
// fetch the room first and check here instead, same pattern as
// modules/offers/controller.ts's assertScope.
function assertScope(req: Request, propertyId: string) {
  if (!req.admin) throw ApiError.unauthorized();
  if (req.admin.role === "super_admin") return;
  if (req.admin.role === "villa_manager" && req.admin.propertyScopeId === propertyId) return;
  throw ApiError.forbidden("Not scoped to this property");
}

export async function updateRoom(req: Request, res: Response) {
  const room = await service.getRoom(req.params.roomId);
  if (!room) throw ApiError.notFound("Room not found");
  assertScope(req, room.propertyId);
  res.json(await service.updateRoom(req.params.roomId, req.body));
}

export async function deleteRoom(req: Request, res: Response) {
  const room = await service.getRoom(req.params.roomId);
  if (!room) throw ApiError.notFound("Room not found");
  assertScope(req, room.propertyId);
  await service.deleteRoom(req.params.roomId);
  res.status(204).send();
}
