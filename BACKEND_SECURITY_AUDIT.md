# Mansello backend: security and issues audit

**Date:** 2026-10-05
**Scope:** all of `src/` (about 5,600 lines), `prisma/schema.prisma`, the
migrations, production dependencies (`npm audit --omit=dev`), and read-only
checks against the live Supabase database (table security settings, grants,
row counts).

**Status:** findings only. **Nothing has been changed yet.** Items marked
**Frontend?** change something the frontend reads or sends, so they need
sign-off before we ship them. Everything else can be fixed on the backend
alone, with no change visible to the frontend.

---

## Summary

| # | Severity | Finding | Frontend? |
|---|---|---|---|
| C1 | **Critical** | Supabase: every table readable through the public `anon` role (RLS off on all 27 tables) | Confirm only |
| C2 | **Critical** | Any guest's name, email, phone and price can be looked up by anyone (availability → booking id → booking) | **Yes** |
| C3 | **Critical** | Marketplace checkout accepts negative/fractional quantities, so customers can lower their own total | No |
| H1 | High | Public property endpoints leak iCal secrets (our export token + Airbnb/Booking.com feed URLs) | **Yes** |
| H2 | High | A guest who pays after their 15-minute hold expired is charged with no booking and no refund | Maybe |
| H3 | High | Booking cancel can refund twice, refunds unpaid bookings, has no upper bound on refunds, and isn't property-scoped | No |
| H4 | High | Booking endpoint has no rate limit, accepts past dates and unlimited stay length (calendar can be held hostage) | Confirm limits |
| H5 | High | Guest passport/ID uploads are stored in a **public** storage bucket | **Yes** |
| H6 | High | Vulnerable dependencies: `multer`, `axios` (high); `qs`, `morgan`, `moment`, `ip-address` (moderate) | No |
| M1 | Medium | Villa managers aren't limited to their own property on several admin endpoints | No |
| M2 | Medium | Several endpoints save the request body without validating it (2 of them public) | Check payloads |
| M3 | Medium | A failed confirmation email makes Stripe retry, and the retry never sends the email | No |
| M4 | Medium | Public order/booking lookups return full contact details | **Yes** |
| M5 | Medium | Guest-supplied names are inserted into email HTML unescaped | No |
| M6 | Medium | "Not found", "already exists" and bad-enum errors come back as generic 500s | No |
| M7 | Medium | Secret tokens appear in request logs | No |
| M8 | Medium | Local `.env` points at the production database, so `npm run dev` runs live cron jobs on prod | No |
| L1–L8 | Low | JWT algorithm pinning, hygiene, ops notes (see end) | Mostly no |

Already in good shape (checked, no action needed): Stripe webhook signature
verification, server-side pricing for bookings, no raw-SQL injection paths
(no `$queryRawUnsafe` anywhere in `src/`), upload content sniffing, CORS
allow-list, helmet, login rate limiting, refresh-token revocation on logout,
strong and distinct JWT secrets (checked in the local `.env`, so confirm
Railway uses equally strong ones), and site-content URL validation.

---

## Critical

### C1. Supabase: every table readable through the public `anon` role

**What we found (live DB):** row-level security (RLS) is **disabled on all 27
tables** in the `public` schema. The `anon` and `authenticated` roles hold
`SELECT` on all of them. Supabase's default grants also usually include
`INSERT`/`UPDATE`/`DELETE`, which we haven't checked yet.

**Impact:** Supabase serves the `public` schema over its REST API
(`https://<project>.supabase.co/rest/v1/...`). Anyone with the project's
**anon key** can read every table from there. That includes `AdminUser`
(password hashes), `Booking` (guest names, emails, phones, ID document
numbers), `BookingInfoRequest` (passport answers and file URLs), `Order`
(addresses), and `Property` (iCal secrets). This bypasses the backend
entirely. The anon key is designed to be public, not a secret. The project ref
(`sgpiezmmjpclcpfkvgvd`) is already visible in every product image URL.

**Fix (backend only):** add one migration that runs
`ALTER TABLE "<table>" ENABLE ROW LEVEL SECURITY;` on every table, with **no
policies**. Prisma connects as the table owner (`postgres`), which bypasses
RLS, so the app is unaffected. `anon`/`authenticated` then see nothing. As a
belt-and-braces step, also `REVOKE ALL ... FROM anon, authenticated`. Check
afterwards in Supabase → Advisors → Security.

**Frontend:** confirm the frontend never talks to Supabase directly (no
`supabase-js` reading tables). If it does, that read path needs replacing
with a backend endpoint first.

### C2. Any guest's personal details can be looked up by anyone

**Where:**
[availability/service.ts](src/modules/availability/service.ts) `listBlocksForProperty`,
[bookings/controller.ts](src/modules/bookings/controller.ts) `getBooking`

**How the lookup works:**
1. `GET /api/availability/:propertyId` is public, and returns every block's
   full row, **including `bookingId`**, plus `externalUid`, `roomId` and
   `source`.
2. `GET /api/bookings/:id` is public, and returns the booking's `guestName`,
   `guestEmail`, `guestPhone`, dates, price and `stripePaymentIntentId`.

So anyone can list every guest of both properties, past and future, with
two unauthenticated requests per booking. The UUID-secrecy argument for (2)
fails because (1) hands the UUIDs out.

**Fix:**
- Public availability returns only what the calendar needs:
  `{ startDate, endDate, status }`, plus `source` if the calendar shows it.
  The full row, including `bookingId`, `externalUid` and `roomId`, is returned
  only when an admin token is present (via `optionalAuth`, the same pattern as
  blog/products).
- Also apply M4 to `GET /api/bookings/:id`.

**Frontend:** please confirm:
- which fields the **public** calendar reads from this endpoint;
- whether the **admin** Calendar & Blocks tab calls the same endpoint (it will
  need to send the admin token to keep getting `bookingId`/`externalUid`).

Note: the `externalUid` label stopgap from the previous doc is no longer
needed. Every Booking.com row is now `source = booking_com`.

### C3. Customers can lower their own marketplace total

**Where:** `POST /api/marketplace/orders`,
[orders/service.ts](src/modules/marketplace/orders/service.ts) `createOrder`.
The body has **no validation at all**.

**Impact:**
- `quantity` can be negative or fractional, e.g. items
  `[{A, qty 1, $100}, {B, qty -1, $90}]` gives a $10 subtotal. Stripe charges
  $10 plus shipping.
- On confirmation, `decrement: -1` *increases* B's stock.
- `quantity: 0.01` sells an item at 1% of its price.
- There's no stock check at order time, so `quantityOnHand` can go negative
  (overselling).
- Missing or non-string customer fields cause a 500.

**Fix (backend only):** add a zod schema:
- `items` is non-empty, max ~50 entries, with unique `productId`s;
- `productId` is a uuid; `quantity` is an integer from 1 to 99;
- name, phone and address are trimmed non-empty strings with length caps.

Reject with 409 when `quantity > quantityOnHand`. Also re-check stock inside
`confirmOrder`'s transaction, and decide what happens when a paid order can't
be fulfilled: refund, or allow backorder.

**Frontend:** no change, assuming the cart only ever sends positive integer
quantities. Please confirm the max quantity the UI allows.

---

## High

### H1. Public property endpoints leak iCal secrets

**Where:** `GET /api/properties` and `GET /api/properties/:slug`. Both are
public and return the raw `Property` row.

**Leaks:**
- `icalExportToken`: the secret in our own export feed URL.
- `airbnbIcalImportUrls`: each URL embeds Airbnb's or Booking.com's per-listing
  secret token.
- `icalImportStatus`: the same URLs again (added in the last change).

`getBooking` already strips the first two, but these two endpoints don't.

**Fix:** strip all three from public responses. Serve them from an
admin-only route, either `GET /api/admin/properties/:id` or the existing
public route when a scoped admin token is present. After the fix, regenerate
`icalExportToken` and re-paste the new export URL into Airbnb and Booking.com:
the old token should be treated as compromised.

**Frontend:** the villa admin Settings tab (import URLs, export URL, sync
status) must read from the admin route or send the token. Tell us which you
prefer.

### H2. Guests charged after their hold expired get no booking and no refund

**Where:**
- [webhooks.ts](src/modules/payments/webhooks.ts) `payment_intent.succeeded`
- `expireStalePendingBookings`
- `expireStalePendingOrders`

**Impact:**
- A booking hold lasts 15 minutes (`BOOKING_HOLD_MINUTES`), but the Stripe
  PaymentIntent stays payable indefinitely.
- If a guest pays at minute 16 (slow 3-D Secure, tab left open), the job has
  already cancelled the booking and freed the dates.
- The webhook then finds no `pending_payment` booking, **logs a warning and
  does nothing**. The guest is charged, gets no booking and no email, and the
  dates may be resold.
- Marketplace orders have the same problem after the 24-hour expiry.

**Fix (backend):**
1. When a hold/order expires or is released, **cancel its PaymentIntent**
   (`stripe.paymentIntents.cancel`). This makes a late payment impossible.
   Ignore the error when it has already succeeded.
2. Backstop in the webhook: if the PaymentIntent matches a cancelled
   booking/order, re-confirm it if the dates/stock are still free. Otherwise
   **refund automatically** and email the guest.

**Frontend:** optional. Show the hold countdown, and handle Stripe's "payment
intent canceled" error with a "your hold expired, please start again"
message.

### H3. Booking cancellation and refund problems

**Where:** `POST /api/bookings/:id/cancel`,
[bookings/controller.ts](src/modules/bookings/controller.ts) and `cancelBooking`
in [bookings/service.ts](src/modules/bookings/service.ts).

- **No status guard.** An already-cancelled booking can be cancelled again,
  which **issues another refund** (e.g. 50% twice adds up to 100%). A
  `completed` booking can also be cancelled.
- **Unpaid bookings.** For `pending_payment`, it calls `refunds.create` on a
  PaymentIntent that never succeeded. Stripe errors *after* the DB is already
  cancelled, so the admin sees a 500 for a cancellation that actually happened.
  The fix is to cancel the PaymentIntent instead.
- **Unbounded override.** `refundOverride` has no upper bound against
  `totalPrice`.
- **Order of operations.** The DB is cancelled first and the refund is
  attempted second. If the refund fails, nothing records that money is still
  owed. Store a `refundStatus` / `refundError` (or the Stripe refund id) so
  it's visible and retryable.
- **No property scope.** A villa manager can cancel and refund the *other*
  property's bookings (see M1).

**Fix (backend only):**
- Only `confirmed` or `paid_offline` bookings can be cancelled.
- Clamp `refundOverride` to the range 0 to the amount actually paid.
- Persist the Stripe refund id.
- Add a scope check.

### H4. The booking calendar can be held hostage

**Where:** `POST /api/bookings` (public) and `computeBookingPrice`.

- **No rate limit.** Each call holds the dates for 15 minutes and creates a
  Stripe PaymentIntent, so a script can keep every future night of both
  properties held permanently. It also creates Stripe API noise that can look
  like card-testing abuse.
- **No past-date check.** A booking for 2019 is accepted.
- **No maximum stay or advance window.** A 10-year stay is priced night by
  night in a loop and blocks the calendar.

**Fix:**
- Add `publicFormLimiter` (or a tighter limit, e.g. 10 per 10 minutes per IP).
- Reject `checkIn` before today in the property's timezone.
- Add a max stay (proposal: 60 nights) and a max advance window (proposal:
  18 months).
- Optionally, cap the number of concurrent `pending_payment` holds per
  email/IP.

**Frontend:** confirm the max stay and advance window we pick don't conflict
with what the calendar allows.

### H5. Guest passport/ID uploads are publicly accessible

**Where:** [imageUpload.ts](src/modules/uploads/imageUpload.ts)
`uploadDocument`, used by `POST /api/booking-info-requests/:token/uploads`.

**Impact:** documents go into the same bucket as product images, which is
served from `.../storage/v1/object/public/mansello/guest-documents/...`, i.e.
a **public** bucket. Anyone with a URL can open the passport scan forever.
The URLs are UUID-based, but they're stored in `answers` and pass through the
browser and logs. For Italian guests this is personal-data handling under
GDPR.

**Fix:**
- Use a separate **private** bucket for `guest-documents/`.
- Store the object *key*, not a public URL.
- When the admin views a submission, return short-lived **signed URLs** (e.g.
  15 minutes).
- Migrate existing documents and delete the public copies.
- Add a retention rule, e.g. delete documents N days after checkout.

**Frontend:** the guest upload response would return an opaque key/id
instead of a viewable URL, and the admin submission view would get signed
URLs from the API. Please confirm how the frontend uses the returned `urls`.
For example, does the guest form preview them?

### H6. Vulnerable dependencies

`npm audit --omit=dev` (production dependencies only):

| Package | Severity | Relevance |
|---|---|---|
| `multer` ≤2.3.0 | High | Several DoS issues, and we use it on **public** guest-document uploads |
| `axios` ≤1.19.0 | High | Pulled in by `node-ical` for iCal fetches |
| `qs` | Moderate | Express query/body parsing, DoS |
| `morgan` | Moderate | Log injection |
| `moment`, `ip-address` | Moderate | Indirect |

**Fix:** `npm audit fix` (no breaking changes reported), then run a quick
smoke test of uploads and iCal sync.

---

## Medium

### M1. Villa managers aren't limited to their own property everywhere

Only one admin exists today (a `super_admin`), so this isn't exploitable yet.
It **must** be fixed before any `villa_manager` account is created.

| Endpoint | Problem |
|---|---|
| `DELETE /api/availability/blocks/:blockId` | No property scope check. Can also "release" a **direct booking's** block, which makes paid dates bookable while the booking stays confirmed. Should only release `manual` (and maybe imported) blocks. |
| `POST /api/bookings/:id/cancel` | No property scope check, and it triggers refunds. |
| `GET /api/admin/dashboard` | Any admin role, including `marketplace_manager`, sees every property's guests and revenue. |
| `GET /api/leads/*` | All admin roles see every lead from both sites. Probably fine, but please confirm. |

### M2. Endpoints that save the request body unvalidated

**Public:**
- `POST /api/leads/contact` and `POST /api/leads/transport-requests` pass
  `req.body` straight into `prisma.create`. A caller can set `status`, `id`,
  `createdAt`, or an arbitrary `bookingId`/`propertyId`, and malformed input
  becomes a 500.
- `POST /api/booking-info-requests/:token/submit` doesn't check that answer
  keys match the form's fields, or that "file" answers are URLs we issued.
  A guest could plant a link that the admin later clicks.

**Admin:**
- catalog category/product create and update (body passed through as-is)
- `PUT .../pricing-tiers`
- `POST .../stock-adjustment`
- `PATCH /orders/:id/status`
- lead status PATCHes
- `POST /api/admin/users` (no email format check, no password minimum, role
  not checked against the enum)

**Fix:** zod schemas like the rest of the codebase already uses. Unknown keys
get stripped.

**Frontend:** we'd validate against the payloads the frontend sends today, so
please share or confirm the request shapes for contact and transport
requests.

### M3. Lost booking confirmation emails

If Resend fails after `confirmBooking` succeeds, the webhook handler throws
and returns a 500, and Stripe retries. The retry finds the booking already
confirmed (`count === 0`) and skips the email, so it's **never sent**.

**Fix:** catch and log email errors inside the webhook and still return 200.
Ideally, record `confirmationEmailSentAt` so a job can retry.

### M4. Public order and booking lookups return full contact details

- `GET /api/marketplace/orders/:id` returns the customer's name, phone and
  delivery address.
- `GET /api/bookings/:id` returns the guest's email and phone.

Both are protected only by the UUID, which is weak on its own. C2 shows the
booking UUIDs are already exposed.

**Fix:** return only what the confirmation pages display (status, dates or
items, totals, first name), or require a second factor (the email/phone used
at checkout) or a signed token in the confirmation URL.

**Frontend:** please list the fields the booking and order confirmation
pages display.

### M5. HTML injection in emails

[email.ts](src/modules/notifications/email.ts) inserts `guestName`,
`propertyName`, `customerName` and the link into HTML with no escaping. Since
we send from our verified domain, a crafted name could inject links or
markup.

**Fix:** HTML-escape every interpolated value.

### M6. Wrong error codes

- Prisma `P2025` (record not found) on PATCH/DELETE of an unknown id returns
  500 instead of 404.
- `P2002` (unique violation, e.g. duplicate SKU) returns 500 instead of 409.
- An invalid enum value in `?status=` filters returns 500 instead of 400.

**Fix:** map these in
[errorHandler.ts](src/middleware/errorHandler.ts).

**Frontend:** the user-visible messages get better, and the response shape
is unchanged.

### M7. Secret tokens in request logs

`morgan("combined")` logs full URLs, which include:
- `/ical/<icalExportToken>.ics`
- `/api/booking-info-requests/<token>`

Railway keeps these logs.

**Fix:** a custom morgan token that masks path segments on those routes.

### M8. Local development runs against the production database

The local `.env` `DATABASE_URL` is the production Supabase pooler.
`npm run dev` starts the cron jobs too, so every local run:
- syncs iCal into prod;
- expires holds;
- sends low-stock emails;
- writes test data into live tables.

**Fix:** a separate Supabase project (or branch) for development, and point
`.env` at it. Optionally add a `DISABLE_JOBS=true` flag for local runs.

---

## Low / hygiene

- **L1.** `jwt.verify` doesn't pin the algorithm. Add
  `{ algorithms: ["HS256"] }` in [auth.ts](src/middleware/auth.ts) and
  [admin/service.ts](src/modules/admin/service.ts).
- **L2.** Login only runs bcrypt when the email exists, so response timing
  reveals which admin emails are valid. Compare against a dummy hash when the
  user doesn't exist.
- **L3.** Access tokens stay valid for up to 15 minutes after logout (a
  documented trade-off). **Frontend:** if tokens are kept in `localStorage`,
  any XSS can steal them. Consider moving the refresh token to an `httpOnly`
  cookie.
- **L4.** Only one admin account exists (a `super_admin`). A second
  super_admin would prevent lock-out if that account's credentials are lost.
- **L5.** `Booking.guestIdDocumentNumber` and guest-info answers are kept
  forever in plain text. Define a retention policy (GDPR), e.g. clear them
  N days after checkout.
- **L6.** Cron jobs run inside the web process. If Railway ever runs more
  than one replica, every job runs once per replica: double emails and
  competing iCal syncs. Keep a single replica, or add a Postgres advisory
  lock around each job.
- **L7.** No tests exist, and `npm run lint` fails because there's no ESLint
  config. The booking/overlap/refund logic deserves unit tests before the
  H2/H3 changes.
- **L8.** Dead or stale code: `sendOrderConfirmation` (unused, still says
  "cash on delivery") and the `pricePerKg` fallback in shipping (meant to be
  removed after one release). There's also still **1 zero-length manual
  block** in the DB from the earlier report. It blocks nothing; release it
  from the admin or delete it.

---

## Proposed order of work

1. **Immediately, backend only, invisible to the frontend:** C1 (RLS
   migration), C3 (order validation), H6 (`npm audit fix`), H3 (cancel
   guards), H4 (rate limit + date checks), M3, M5, L1.
2. **After frontend confirmation:** C2 + H1 + M4 (response shaping and admin
   routes), then rotate `icalExportToken`. Then H5 (private documents bucket).
3. **Next:** H2 (cancel PaymentIntents on expiry + webhook refund backstop),
   M1, M2, M6, M7.
4. **Ops:** M8 (dev database), L4–L7.

## Questions for the frontend

1. Does anything in the frontend use `supabase-js` or talk to Supabase
   directly? (C1)
2. Which fields does the public booking calendar read from
   `GET /api/availability/:propertyId`? Does the admin Calendar & Blocks tab
   use the same endpoint, and does it send the admin token? (C2)
3. Where does the villa admin Settings tab load `airbnbIcalImportUrls`,
   `icalExportToken` and `icalImportStatus` from? Are you OK switching to an
   admin-authenticated route? (H1)
4. What does the guest booking-info form do with the `urls` returned by the
   upload endpoint (preview, display, just pass back on submit)? (H5)
5. What do the booking and order confirmation pages display? (M4)
6. What's the maximum cart quantity, maximum stay length and booking horizon
   the UI allows? (C3, H4)
7. What are the exact request bodies for the contact form and the
   transport-request form? (M2)
