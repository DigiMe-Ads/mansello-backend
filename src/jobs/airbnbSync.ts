import ical from "node-ical";
import { AvailabilitySource, Prisma } from "@prisma/client";
import { prisma } from "@/db/prisma";
import { icalUrlHost, splitIcalUrls } from "@/utils/icalUrls";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Every source this job writes. The stale-block release step below must
// cover all of them, or a Booking.com block that disappears from its feed
// would never be released.
const IMPORTED_SOURCES: AvailabilitySource[] = ["airbnb", "booking_com"];

// node-ical builds a VALUE=DATE value at *local* midnight. Re-anchor it to
// UTC midnight of the same calendar day so it round-trips through a
// `@db.Date` column unchanged whatever the server's timezone (a no-op on a
// UTC server), and so the range arithmetic below compares like with like.
function toUtcDate(d: Date, dateOnly: boolean): Date {
  return dateOnly ? new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) : d;
}

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
  const dateOnly = event.datetype === "date";
  const start = toUtcDate(event.start, dateOnly);
  // A VEVENT with no DTEND is a one-day event (RFC 5545 §3.6.1).
  let endDate: Date = event.end
    ? toUtcDate(event.end, dateOnly)
    : new Date(start.getTime() + MS_PER_DAY);

  // Only ever adjust a whole-day (VALUE=DATE) event — a VALUE=DATE-TIME
  // DTEND is a real checkout time, not a padded calendar day, and must be
  // left untouched. `event.datetype` reflects DTSTART's VALUE parameter
  // (node-ical), which for a stay-shaped VEVENT is set consistently
  // whether or not DTEND itself was present in the feed.
  if (!icalCheckoutDayBuffer && dateOnly) {
    endDate = new Date(endDate.getTime() - MS_PER_DAY);
  }

  // Guard against a genuine one-night stay collapsing to zero nights —
  // startDate == endDate blocks nothing under this system's half-open
  // [start, end) semantics, which would silently un-block a real,
  // occupied night. Keep at least one.
  if (endDate.getTime() <= start.getTime()) {
    endDate = new Date(start.getTime() + MS_PER_DAY);
  }

  return endDate;
}

// Booking.com's feed (ical.booking.com, UIDs "…@booking.com") gets its own
// source so the admin can tell the channels apart. Anything unrecognised
// stays `airbnb`, which is what every import was tagged before.
export function detectSource(feedUrl: string, uid: string): AvailabilitySource {
  const host = icalUrlHost(feedUrl);
  if (host === "booking.com" || host.endsWith(".booking.com")) return "booking_com";
  if (uid.toLowerCase().endsWith("@booking.com")) return "booking_com";
  return "airbnb";
}

type Range = { start: Date; end: Date };

// [start, end) minus every range in `taken` (half-open, same as storage).
function subtractRanges(range: Range, taken: Range[]): Range[] {
  let pieces: Range[] = [range];
  for (const t of taken) {
    pieces = pieces.flatMap((p) => {
      if (t.end <= p.start || t.start >= p.end) return [p];
      const out: Range[] = [];
      if (t.start > p.start) out.push({ start: p.start, end: t.start });
      if (t.end < p.end) out.push({ start: t.end, end: p.end });
      return out;
    });
  }
  return pieces;
}

// Writes one feed event as this property's block(s), keyed by
// (propertyId, externalUid) with no assumption about the UID's domain.
//
// The `availability_block_no_overlap_no_booking` exclusion constraint
// forbids ANY two active non-booking blocks on a property from overlapping.
// Once a property imports more than one channel, overlap is normal, not an
// error: Booking.com's export re-publishes as "CLOSED - Not available" the
// nights it has already closed because of another channel's calendar (e.g.
// an Airbnb reservation), and the client may close the same nights by hand
// on both. Inserting such an event whole was rejected by the constraint and
// only logged, so a Booking.com range that *partly* overlapped another block
// left its remaining nights bookable. Instead, store just the part of the
// event's range no other active block already covers, which may be several
// rows sharing one externalUid, or none if it's fully covered. Nights covered
// by another block are blocked either way.
//
// Idempotent: the result is recomputed from the feed each run and the rows
// are only rewritten when it actually changes.
async function upsertImportedEvent(
  property: { id: string; slug: string },
  uid: string,
  source: AvailabilitySource,
  range: Range
) {
  const others = await prisma.availabilityBlock.findMany({
    where: {
      propertyId: property.id,
      status: "active",
      startDate: { lt: range.end },
      endDate: { gt: range.start },
      OR: [{ externalUid: null }, { externalUid: { not: uid } }],
    },
    orderBy: { startDate: "asc" },
  });

  // Overlapping a direct booking is a genuine double-booking (the channel
  // sold nights we already sold) — still needs manual reconciliation, same
  // as before this change (BACKEND_PLAN.md §4). Overlap with another
  // imported or manual block is just the same nights closed twice.
  const directClash = others.find((b) => b.source === "direct");
  if (directClash) {
    console.error(
      `iCal/direct date conflict on property ${property.slug}: event ${uid} (${source}) overlaps direct booking ${directClash.bookingId ?? directClash.id}`
    );
  }

  const segments = subtractRanges(
    range,
    others.map((b) => ({ start: b.startDate, end: b.endDate }))
  );

  const own = await prisma.availabilityBlock.findMany({
    where: { propertyId: property.id, externalUid: uid },
    orderBy: { startDate: "asc" },
  });
  const ownActive = own.filter((b) => b.status === "active");
  const unchanged =
    ownActive.length === own.length &&
    own.length === segments.length &&
    own.every(
      (b, i) =>
        b.source === source &&
        b.startDate.getTime() === segments[i].start.getTime() &&
        b.endDate.getTime() === segments[i].end.getTime()
    );
  if (unchanged) return;

  try {
    await prisma.$transaction([
      prisma.availabilityBlock.deleteMany({ where: { propertyId: property.id, externalUid: uid } }),
      prisma.availabilityBlock.createMany({
        data: segments.map(
          (s): Prisma.AvailabilityBlockCreateManyInput => ({
            propertyId: property.id,
            startDate: s.start,
            endDate: s.end,
            source,
            status: "active",
            externalUid: uid,
          })
        ),
      }),
    ]);
  } catch (err) {
    // Only reachable via a race (e.g. a direct booking committed between
    // the read above and this write). Log and move on rather than aborting
    // the rest of the feed and the stale-block release step — see
    // BACKEND_CHANGES_AIRBNB_SYNC_UPDATE_CONFLICT_FIX.md.
    console.error(`iCal date conflict writing property ${property.slug}, event ${uid}:`, err);
  }
}

type ImportStatus = { url: string; lastSyncedAt: string | null; lastSyncError: string | null };

function readImportStatus(value: Prisma.JsonValue): ImportStatus[] {
  return Array.isArray(value) ? (value as unknown as ImportStatus[]) : [];
}

// Pulls each property's iCal import feeds (Airbnb, Booking.com, …), diffs
// them against stored imported availability_blocks, and upserts. Our own
// export feed (/ical/:token.ics) only ever publishes `direct` and `manual`
// blocks, never these imported ones, so channels don't echo each other's
// bookings back through us.
export async function syncAirbnbCalendars() {
  const properties = await prisma.property.findMany({
    where: { airbnbIcalImportUrls: { isEmpty: false } },
  });

  for (const property of properties) {
    // A property can be listed multiple times on Airbnb (whole villa + individual
    // rooms sold separately, etc.) plus on Booking.com — merge every feed into this
    // one property's shared AvailabilityBlock pool. The same externalUid can
    // legitimately show up in more than one feed (Airbnb pushes a block to sibling
    // listings when one of them gets booked); seenUids processes it once.
    const seenUids = new Set<string>();
    let allFeedsSucceeded = true;
    const previousStatus = readImportStatus(property.icalImportStatus);
    const status: ImportStatus[] = [];

    for (const url of splitIcalUrls(property.airbnbIcalImportUrls)) {
      const previous = previousStatus.find((s) => s.url === url);
      try {
        const events = await ical.async.fromURL(url);
        const vevents = Object.values(events).filter(
          (e): e is ical.VEvent => e.type === "VEVENT"
        );

        // Deliberately no filtering on SUMMARY ("Reserved", "Airbnb (Not
        // available)", Booking.com's "CLOSED - Not available", …): every
        // VEVENT in an OTA export is unavailable time.
        for (const event of vevents) {
          // RFC 5545 STATUS:CANCELLED — a cancelled reservation should be
          // removed, not imported/adjusted. Simplest correct handling:
          // don't add it to seenUids, so the "release stale blocks" step
          // below cancels any previously-imported block for it exactly the
          // same way it already does for an event that disappears from the
          // feed entirely (Airbnb typically does both over a event's
          // lifetime, and this backend has no way to distinguish which,
          // nor any reason to).
          if (event.status === "CANCELLED") continue;
          if (!event.uid || !event.start || seenUids.has(event.uid)) continue;

          seenUids.add(event.uid);
          await upsertImportedEvent(property, event.uid, detectSource(url, event.uid), {
            start: toUtcDate(event.start, event.datetype === "date"),
            end: resolveEndDate(event, property.icalCheckoutDayBuffer),
          });
        }
        status.push({ url, lastSyncedAt: new Date().toISOString(), lastSyncError: null });
      } catch (err) {
        allFeedsSucceeded = false;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`iCal sync failed for property ${property.slug}, feed host ${icalUrlHost(url)}:`, message);
        status.push({ url, lastSyncedAt: previous?.lastSyncedAt ?? null, lastSyncError: message });
        // Intentionally non-fatal — one feed failing shouldn't stop this property's
        // other feeds or the other properties. But since we don't know what that
        // feed's blocks were, we must skip the "release stale blocks" step below —
        // otherwise a block that's still live on the failed feed would get
        // incorrectly cancelled just because we couldn't see it this round,
        // reopening dates that are actually still booked.
      }
    }

    await prisma.property.update({
      where: { id: property.id },
      data: { icalImportStatus: status },
    });

    if (!allFeedsSucceeded) continue;

    // Anything previously imported that's no longer in ANY of this property's
    // feeds was removed/cancelled on the channel's side — release it.
    await prisma.availabilityBlock.updateMany({
      where: {
        propertyId: property.id,
        source: { in: IMPORTED_SOURCES },
        status: "active",
        externalUid: { notIn: Array.from(seenUids) },
      },
      data: { status: "cancelled" },
    });
  }
}
