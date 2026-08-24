import { Request, Response } from "express";
import * as service from "./service";

export async function listShippingRates(_req: Request, res: Response) {
  res.json(await service.listShippingRates());
}

export async function replaceShippingRates(req: Request, res: Response) {
  res.json(await service.replaceShippingRates(req.body.rates));
}
