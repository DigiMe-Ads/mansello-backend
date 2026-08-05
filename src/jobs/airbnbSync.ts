import ical from "node-ical";
import { prisma } from "@/db/prisma";

// Pulls each property's Airbnb export feed, diffs it against stored
// `airbnb`-sourced availability_blocks, and upserts. Booking dates already
// held by a `direct` block are left alone — Airbnb's own calendar excludes
// them anyway because we publish our own export feed back to Airbnb.
export async function syncAirbnbCalendars() {
  const properties = await prisma.property.findMany({
    where: { airbnbIcalImportUrls: { isEmpty: false } },
  });

  for (const property of properties) {
    // A property can be listed multiple times on Airbnb (whole villa + individual
    // rooms sold separately, etc.) — merge every feed into this one property's
    // shared AvailabilityBlock pool. The same externalUid can legitimately show up
    // in more than one feed (Airbnb pushes a block to sibling listings when one of
    // them gets booked); findFirst-by-uid below already dedupes that per property.
    const seenUids = new Set<string>();
    let allFeedsSucceeded = true;

    for (const url of property.airbnbIcalImportUrls) {
      try {
        const events = await ical.async.fromURL(url);
        const airbnbEvents = Object.values(events).filter(
          (e): e is ical.VEvent => e.type === "VEVENT"
        );

        for (const event of airbnbEvents) {
          seenUids.add(event.uid);
          const existing = await prisma.availabilityBlock.findFirst({
            where: { propertyId: property.id, externalUid: event.uid },
          });

          if (existing) {
            await prisma.availabilityBlock.update({
              where: { id: existing.id },
              data: { startDate: event.start, endDate: event.end, status: "active" },
            });
          } else {
            try {
              await prisma.availabilityBlock.create({
                data: {
                  propertyId: property.id,
                  startDate: event.start,
                  endDate: event.end,
                  source: "airbnb",
                  status: "active",
                  externalUid: event.uid,
                },
              });
            } catch (err) {
              // Exclusion constraint rejected it — a direct booking already
              // holds an overlapping range. This is the residual sync-lag risk
              // documented in BACKEND_PLAN.md §4: log it so the admin dashboard
              // can surface it for manual reconciliation, rather than crash the sync.
              console.error(
                `Airbnb/direct date conflict for property ${property.slug}, event ${event.uid}:`,
                err
              );
            }
          }
        }
      } catch (err) {
        allFeedsSucceeded = false;
        console.error(`Airbnb iCal sync failed for property ${property.slug}, feed ${url}:`, err);
        // Intentionally non-fatal — one feed failing shouldn't stop this property's
        // other feeds or the other properties. But since we don't know what that
        // feed's blocks were, we must skip the "release stale blocks" step below —
        // otherwise a block that's still live on the failed feed would get
        // incorrectly cancelled just because we couldn't see it this round,
        // reopening dates that are actually still booked.
      }
    }

    if (!allFeedsSucceeded) continue;

    // Anything previously imported that's no longer in ANY of this property's
    // feeds was removed/cancelled on Airbnb's side — release it.
    await prisma.availabilityBlock.updateMany({
      where: {
        propertyId: property.id,
        source: "airbnb",
        status: "active",
        externalUid: { notIn: Array.from(seenUids) },
      },
      data: { status: "cancelled" },
    });
  }
}
