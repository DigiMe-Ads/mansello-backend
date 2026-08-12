import { Request, Response } from "express";
import { ApiError } from "@/utils/ApiError";
import * as service from "./service";

export async function login(req: Request, res: Response) {
  res.json(await service.login(req.body.email, req.body.password));
}

export async function refresh(req: Request, res: Response) {
  res.json(service.refresh(req.body.refreshToken));
}

export async function createAdminUser(req: Request, res: Response) {
  res.status(201).json(await service.createAdminUser(req.body));
}

export async function listAdminUsers(_req: Request, res: Response) {
  res.json(await service.listAdminUsers());
}

// req.admin is the caller (set by requireAuth), req.params.id is the target
// — block a super_admin from deleting the account they're currently using,
// which would strand their own session (they'd still hold a valid access
// token for a few more minutes, but the refresh — and every login after —
// would fail with no way back in without another super_admin's help).
export async function deleteAdminUser(req: Request, res: Response) {
  if (req.admin?.sub === req.params.id) {
    throw ApiError.badRequest("You can't delete your own account");
  }
  await service.deleteAdminUser(req.params.id);
  res.status(204).send();
}

export async function getDashboard(_req: Request, res: Response) {
  res.json(await service.getDashboard());
}

export async function me(req: Request, res: Response) {
  res.json({ admin: req.admin });
}
