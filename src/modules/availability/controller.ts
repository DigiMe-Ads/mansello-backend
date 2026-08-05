import { Request, Response } from "express";
import * as service from "./service";

export async function listBlocks(req: Request, res: Response) {
  const { from, to } = req.query as { from?: string; to?: string };
  res.json(await service.listBlocksForProperty(req.params.propertyId, from, to));
}

export async function createManualBlock(req: Request, res: Response) {
  const { startDate, endDate, reason } = req.body;
  const block = await service.createManualBlock({
    propertyId: req.params.propertyId,
    startDate: new Date(startDate),
    endDate: new Date(endDate),
    reason,
  });
  res.status(201).json(block);
}

export async function releaseBlock(req: Request, res: Response) {
  res.json(await service.releaseBlock(req.params.blockId));
}
