import { Request, Response } from "express";
import { ApiError } from "@/utils/ApiError";
import * as service from "./service";

export async function listBlocks(req: Request, res: Response) {
  const { from, to } = req.query as { from?: string; to?: string };
  res.json(await service.listBlocksForProperty(req.params.propertyId, from, to));
}

export async function createManualBlock(req: Request, res: Response) {
  const { startDate, endDate, reason, roomId } = req.body;
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw ApiError.badRequest("startDate and endDate must be valid dates");
  }
  // Blocks are half-open [startDate, endDate) — endDate is the first free
  // day, like a check-out date. start == end blocks nothing at all (a real
  // client report: "start 15th, end 15th" to block the 15th).
  if (end <= start) {
    throw ApiError.badRequest(
      "endDate must be after startDate — it's the first free day, so to block only the 15th send start 15th, end 16th"
    );
  }
  const block = await service.createManualBlock({
    propertyId: req.params.propertyId,
    startDate: start,
    endDate: end,
    reason,
    roomId,
  });
  res.status(201).json(block);
}

export async function releaseBlock(req: Request, res: Response) {
  res.json(await service.releaseBlock(req.params.blockId));
}
