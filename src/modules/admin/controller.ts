import { Request, Response } from "express";
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

export async function getDashboard(_req: Request, res: Response) {
  res.json(await service.getDashboard());
}

export async function me(req: Request, res: Response) {
  res.json({ admin: req.admin });
}
