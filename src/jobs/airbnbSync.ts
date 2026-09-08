import ical from "node-ical";
import { prisma } from "@/db/prisma";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// BACKEND_CHANGES_ICAL_MINUS_ONE_DAY.md — some OTA feeds pad an all-day
// DTEND by a day as a conservative safety margin for third-party calendar
// consumers, which (if true for a given feed) blocks the guest's actual
// checkout day from a same-day direct booking. Trimming that back is
// per-property and OFF by default (`icalCheckoutDayBuffer: true` — see the
// Property schema comment): investigated against this backend's own code
// and live data before this shipped — node-ical does not itself pad
// anything (confirmed by reading its DTEND parsing), and neither real
// property's live data showed evidence of feed-side padding either
// (turnoverBufferDays is 0 on both, and The Nest Bologna has several
// genuinely back-to-back Airbnb reservations that could not have imported
// successfully — Postgres's exclusion constraint would have rejected the
// second one — if its feed padded checkout days). Do not flip this to
// `false` for a property without first confirming, from that listing's own
// Airbnb dashboard, that its feed's DTEND really does include the turnover
// day — applying this to a feed that's already correct frees a genuinely
// occupied night and causes exactly the double-booking this guards against.
//
// Applied here, at parse time, from the value read fresh off the feed each
// sync — never as an update to an already-stored row. That's what makes it
// idempotent: a scheduled re-sync reprocessing the same event always
// derives the same adjusted endDate from the same DTEND, rather than
// compounding a -1 on every run.
export function resolveEndDate(event: ical.VEvent, icalCheckoutDayBuffer: boolean): Date {
  let endDate: Date = event.end;

  // Only ever adjust a whole-day (VALUE=DATE) event — a VALUE=DATE-TIME
  // DTEND is a real checkout time, not a padded calendar day, and must be
  // left untouched. `event.datetype` reflects DTSTART's VALUE parameter
  // (node-ical), which for a stay-shaped VEVENT is set consistently
  // whether or not DTEND itself was present in the feed.
  if (!icalCheckoutDayBuffer && event.datetype === "date") {
    endDate = new Date(endDate.getTime() - MS_PER_DAY);
    // Guard against a genuine one-night stay collapsing to zero nights —
    // startDate == endDate blocks nothing under this system's half-open
    // [start, end) semantics, which would silently un-block a real,
    // occupied night. Keep at least one.
    if (endDate.getTime() <= event.start.getTime()) {
      endDate = new Date(event.start.getTime() + MS_PER_DAY);
    }
  }

  return endDate;
}

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
          // RFC 5545 STATUS:CANCELLED — a cancelled reservation should be
          // removed, not imported/adjusted. Simplest correct handling:
          // don't add it to seenUids, so the "release stale blocks" step
          // below cancels any previously-imported block for it exactly the
          // same way it already does for an event that disappears from the
          // feed entirely (Airbnb typically does both over a event's
          // lifetime, and this backend has no way to distinguish which,
          // nor any reason to).
          if (event.status === "CANCELLED") {
            continue;
          }

          seenUids.add(event.uid);
          const endDate = resolveEndDate(event, property.icalCheckoutDayBuffer);
          const existing = await prisma.availabilityBlock.findFirst({
            where: { propertyId: property.id, externalUid: event.uid },
          });

          // Both branches can hit the exclusion constraint (a direct
          // booking, or another Airbnb block, already holds an overlapping
          // range) — this is the residual sync-lag risk documented in
          // BACKEND_PLAN.md §4. Both are wrapped identically: log it for
          // manual admin reconciliation and move on to the next event,
          // rather than letting the exception propagate up to the
          // outer per-feed try/catch, which would abort every event still
          // left in this feed *and* skip the stale-block-release step for
          // this property this run — see
          // BACKEND_CHANGES_AIRBNB_SYNC_UPDATE_CONFLICT_FIX.md for the
          // real live case this was found from (an UPDATE, not a CREATE,
          // which previously had no such guard at all).
          if (existing) {
            try {
              await prisma.availabilityBlock.update({
                where: { id: existing.id },
                data: { startDate: event.start, endDate, status: "active" },
              });
            } catch (err) {
              console.error(
                `Airbnb/direct date conflict updating property ${property.slug}, event ${event.uid}:`,
                err
              );
            }
          } else {
            try {
              await prisma.availabilityBlock.create({
                data: {
                  propertyId: property.id,
                  startDate: event.start,
                  endDate,
                  source: "airbnb",
                  status: "active",
                  externalUid: event.uid,
                },
              });
            } catch (err) {
              console.error(
                `Airbnb/direct date conflict creating property ${property.slug}, event ${event.uid}:`,
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
