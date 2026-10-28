import { Request, Response } from "express";
import * as service from "./service";

export async function getGuide(req: Request, res: Response) {
  res.set("Cache-Control", "public, max-age=60");
  res.json(await service.getGuide(service.toSite(req.params.site)));
}

export async function saveGuide(req: Request, res: Response) {
  res.json(await service.saveGuide(service.toSite(req.params.site), req.body.content, req.admin!.sub));
}

export async function resetGuide(req: Request, res: Response) {
  res.json(await service.resetGuide(service.toSite(req.params.site)));
}
