import { Router } from "express";
import ical from "ical-generator";
import { prisma } from "@/db/prisma";
import { asyncHandler } from "@/utils/asyncHandler";
import { ApiError } from "@/utils/ApiError";

const router = Router();

// Paste this feed's URL into Airbnb's "Import Calendar" field for the
// matching listing, so Airbnb blocks dates we've booked directly.
router.get(
  "/:icalExportToken.ics",
  asyncHandler(async (req, res) => {
    const property = await prisma.property.findUnique({
      where: { icalExportToken: req.params.icalExportToken },
    });
    if (!property) throw ApiError.notFound("Unknown calendar token");

    const blocks = await prisma.availabilityBlock.findMany({
      where: { propertyId: property.id, status: "active", source: { in: ["direct", "manual"] } },
    });

    const calendar = ical({ name: `${property.name} — Mansello` });
    for (const block of blocks) {
      calendar.createEvent({
        start: block.startDate,
        end: block.endDate,
        summary: "Booked",
        id: block.id,
      });
    }

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.send(calendar.toString());
  })
);

export default router;
