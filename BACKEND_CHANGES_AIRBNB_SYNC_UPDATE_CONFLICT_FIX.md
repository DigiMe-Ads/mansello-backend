# Backend fix: Airbnb sync silently stalling on an update conflict

**No frontend action needed.** This is a backend-only bug fix — no API
shape, endpoint, or field changed. Documented here because the bug's
*symptom* was guest-visible (stale/incorrect availability data), even
though the *fix* isn't.

---

## What was broken

`src/jobs/airbnbSync.ts` runs every 30 minutes and imports each property's
Airbnb calendar feed into `AvailabilityBlock` rows. For a **new** reservation
it hadn't seen before, a database conflict (the imported dates overlap an
existing block — a known, accepted residual risk, see `BACKEND_PLAN.md` §4)
was already caught and logged without stopping the sync.

For an **update** to a reservation it already knew about (the feed's dates
for that reservation changed since the last sync), there was no equivalent
guard. If that update collided with the same kind of conflict, the
exception propagated all the way up and aborted the *rest of that sync run
for that property* — every event still left in the feed went unprocessed,
and the step that releases blocks for reservations no longer in the feed
(cancellations, completed stays rolling off) was skipped entirely for that
run.

Because this fires on genuinely conflicting data — not a rare or
theoretical edge case — a property that hits it once tends to hit it again
on the very next run, and the one after that, silently, with nothing
surfaced anywhere except a server-side log line.

## What this looked like in practice

Found while investigating an unrelated, still-open request
(`BACKEND_CHANGES_ICAL_MINUS_ONE_DAY.md`) — running the sync manually
against The Nest Bologna's real feed to verify a different change was a
no-op instead reproduced this crash on a real conflict already present in
the live data.

Once fixed and re-run against the same real feed:

- **10 stale blocks were released immediately** — reservations whose stays
  had already concluded (all in the past relative to when this was found),
  stuck `active` because the release step had been silently skipped on
  every run since this first started conflicting.
- A currently-conflicting reservation was logged (not crashed on) and
  correctly resolved once the feed's own state caught up — in this case, a
  reservation for Sept 9–10 turned out to have actually been cancelled on
  Airbnb's side; the fixed sync picked that up and released it, where the
  broken version never would have.

None of the stale blocks were for future dates, so this specific incident
did not block a real guest from booking real, currently-available dates.
It did mean the admin availability calendar was carrying stale historical
clutter, and — more importantly — that *any future* reservation whose
update happened to conflict would have silently stopped that property's
calendar from staying in sync with Airbnb at all, for as long as the
conflict persisted.

## The fix

`availabilityBlock.update()` is now wrapped in the same log-and-continue
`try/catch` the `create()` path already had. A conflict on either path is
logged for manual admin reconciliation (same as before) and the sync moves
on to the next event, instead of aborting the rest of that property's feed.

No schema change, no new endpoint, no new field on any response. Deployed
in the same change as `BACKEND_CHANGES_ICAL_MINUS_ONE_DAY.md`'s
`icalCheckoutDayBuffer` column, but is otherwise unrelated to it — this fix
applies unconditionally, regardless of that flag's value.

## Why "no frontend action" specifically

- No request/response shape changed on any endpoint.
- The public availability calendar (`GET /api/availability/:propertyId`)
  and booking flow already only ever read `status: active` blocks — this
  fix changes *which rows end up in that state and how promptly*, not how
  the frontend should interpret them.
- The only user-visible effect is that availability data for an
  Airbnb-synced property now stays correctly in sync going forward, instead
  of silently drifting stale after the first conflicting update. That's a
  data-correctness improvement, not a behavior change anything on the
  frontend needs to account for.
