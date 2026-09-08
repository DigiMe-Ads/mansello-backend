import { Request, Response } from "express";
import * as service from "./service";

export async function listTransportRates(req: Request, res: Response) {
  res.json(await service.listTransportRates(req.params.propertyId));
}

export async function replaceTransportRates(req: Request, res: Response) {
  res.json(await service.replaceTransportRates(req.params.propertyId, req.body.rates));
}
