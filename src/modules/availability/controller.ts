import { Request, Response } from "express";
import { ApiError } from "@/utils/ApiError";
import { assertPropertyScope, canAccessProperty } from "@/middleware/auth";
import * as service from "./service";

// Public callers (the booking calendar) get only the three fields they need.
// The full row carries bookingId, which used to let anyone look up any
// guest's details via the public GET /api/bookings/:id
// (BACKEND_SECURITY_AUDIT.md C2). An admin token scoped to this property
// (optionalAuth in routes.ts) still gets everything, for the admin
// Calendar & Blocks tab.
export async function listBlocks(req: Request, res: Response) {
  const { from, to } = req.query as { from?: string; to?: string };
  const blocks = await service.listBlocksForProperty(req.params.propertyId, from, to);
  if (canAccessProperty(req.admin, req.params.propertyId)) return res.json(blocks);
  res.json(blocks.map((b) => ({ startDate: b.startDate, endDate: b.endDate, status: b.status })));
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

// Only manual blocks — the admin UI only offers Release on those. Releasing a
// direct booking's block would make paid-for nights bookable again while the
// booking itself stays confirmed (that's what cancelling the booking is for),
// and an imported block just comes back on the next iCal sync.
export async function releaseBlock(req: Request, res: Response) {
  const block = await service.getBlock(req.params.blockId);
  if (!block) throw ApiError.notFound("Block not found");
  assertPropertyScope(req, block.propertyId);
  if (block.source !== "manual") {
    throw ApiError.badRequest(
      "Only manual blocks can be released here — cancel the booking, or remove it on the channel it came from"
    );
  }
  res.json(await service.releaseBlock(block.id));
}
