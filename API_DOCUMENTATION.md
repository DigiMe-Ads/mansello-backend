# Mansello Backend — API Documentation

Base URL (local dev): `http://localhost:4000`
All request/response bodies are JSON unless noted. Admin-only routes require
`Authorization: Bearer <accessToken>` obtained from `POST /api/admin/login`.

Roles: `super_admin` (everything), `villa_manager` (scoped to one `propertyId`),
`marketplace_manager` (products/orders only).

---

## 1. How the core flows work

### 1.1 Villa availability & the exclusion constraint

Every blocked date range for a property — whether it's a direct booking, an
Airbnb-imported block, or a manual admin block — lives in one table:
`availability_blocks` (`source`: `direct` | `airbnb` | `manual`). A Postgres
**exclusion constraint** on `(property_id, daterange(start_date, end_date))`
(scoped to `status = 'active'`) makes it physically impossible for two active
rows to overlap for the same property — this is enforced by the database
itself, so it holds even under concurrent requests, not just at the
application layer. See `SUPABASE_SETUP.md` for the exact SQL.

### 1.2 Direct booking hold flow

1. Guest picks dates → `POST /api/bookings`.
2. Server creates a `Booking` row (`status = pending_payment`, `expiresAt =
   now + 15min`) **and** an `AvailabilityBlock` row in the same DB
   transaction. The insert either succeeds (dates are now held) or the
   exclusion constraint rejects it and the API returns `409 date_conflict`.
3. Server creates a Stripe `PaymentIntent` on the correct villa's Stripe
   account and returns `clientSecret` to the frontend for Stripe Elements/Checkout.
4. Stripe webhook (`payment_intent.succeeded`) flips the booking to `confirmed`.
5. If the guest abandons checkout, a cron job (every minute, see
   `src/jobs/bookingExpiry.ts`) cancels any `pending_payment` booking past
   its `expiresAt` and releases its `AvailabilityBlock`, freeing the dates.

If `property.turnoverBufferDays > 0`, a new booking also can't start within
that many days of an existing active block ending (or end within that many
days of one starting) — enforced in `computeBookingPrice`
(`src/modules/bookings/service.ts`), returned as `409` with an explanatory
message. Unlike the exact-overlap case, this isn't backed by the DB exclusion
constraint (no per-property-configurable buffer is expressible there), so
it's an application-level check — same class of accepted residual risk as the
Airbnb sync-lag window in §1.3.

### 1.3 Airbnb sync

Every 30 minutes (`AIRBNB_SYNC_CRON`), `src/jobs/airbnbSync.ts` pulls each
property's `airbnb_ical_import_url`, and upserts `source = 'airbnb'` blocks
(deduped by the Airbnb event UID). Our own confirmed/held dates are exposed
back to Airbnb via `GET /ical/:icalExportToken.ics` — paste that URL into
Airbnb's "Import Calendar" field. A same-day double-booking during Airbnb's
own refresh window is a known, accepted residual risk (see
`BACKEND_PLAN.md` §4); if the exclusion constraint ever rejects an Airbnb
event because a direct booking already holds that range, it's logged for
manual admin reconciliation rather than crashing the sync.

### 1.4 Two Stripe accounts

`properties.stripe_account_ref` is `italy` or `sri_lanka`. `src/modules/payments/stripeClients.ts`
holds two independent `Stripe` client instances (two separate accounts, not
Stripe Connect), and every payment/refund call is routed through the client
matching the booking's property. Webhooks are two separate endpoints, each
verified against its own signing secret:
- `POST /webhooks/stripe/italy`
- `POST /webhooks/stripe/sri-lanka`

### 1.5 Marketplace COD order lifecycle

`pending → confirmed → packed → shipped → delivered`, with `cancelled` /
`returned` reachable from most states. Stock is decremented at `confirmed`
(when admin has actually verified the order by phone), not at `pending`, so
an abandoned cart never ties up inventory. Cancelling/returning a
`confirmed`-or-later order restocks automatically. Each `OrderItem` snapshots
`productNameSnapshot` / `unitPriceSnapshot` at order time, so historical
orders stay accurate even if product prices change later. A customer phone
number with 3+ `cancelled`/`returned` orders gets new orders auto-flagged
(`flaggedForReview: true`) for the admin queue — not blocked.

---

## 2. Properties — `/api/properties`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/properties` | public | List both properties with pricing tiers |
| GET | `/api/properties/:slug` | public | Get one property by slug (`the-nest-bologna`, `donas-villa`) |
| PATCH | `/api/properties/:propertyId` | super_admin, villa_manager (own property) | Update config: `minNights`, `turnoverBufferDays`, `checkInTime`, `checkOutTime`, `airbnbIcalImportUrls` (array — a property can be listed multiple times on Airbnb) |
| PUT | `/api/properties/:propertyId/pricing-tiers` | super_admin, villa_manager (own property) | Body: `{ "tiers": [{ "guestCount": 2, "rooms": 1, "pricePerNight": 120 }, ...] }`. `rooms` defaults to 1 if omitted — only Dona's Villa needs more than one tier per `guestCount`. Upserts only — doesn't remove tiers missing from the array |
| DELETE | `/api/properties/:propertyId/pricing-tiers/:tierId` | super_admin, villa_manager (own property) | Remove a single pricing tier. `404` if it doesn't exist or belongs to a different property |

Every `Property` returned by the endpoints above also carries Bologna's
municipal tourist tax (*imposta di soggiorno*) config: `cityTaxEnabled`
(bool, `true` only for The Nest Bologna — Sri Lanka has no equivalent),
`cityTaxMaxNights` (default `5` — nights beyond this aren't taxed, the room
price still is), `cityTaxExemptAgeUnder` (default `14`), and `cityTaxBands`
(`{ minPricePerPersonPerNight, maxPricePerPersonPerNight: number | null,
ratePerPersonPerNight }[]`, sorted ascending, `null` max = the top band).
Set via `prisma/seed.ts`, not through `PATCH /api/properties/:propertyId` —
there's no admin UI for editing these yet. See §4 for how they turn into an
actual charge on a booking.

## 3. Availability — `/api/availability`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/availability/:propertyId?from=YYYY-MM-DD&to=YYYY-MM-DD` | public | Active blocks (direct + Airbnb + manual) for the read-only calendar |
| POST | `/api/availability/:propertyId/blocks` | super_admin, villa_manager (own property) | Manual block. Body: `{ "startDate", "endDate", "reason"? }`. `409` if it overlaps an existing block |
| DELETE | `/api/availability/blocks/:blockId` | super_admin, villa_manager | Release a manual block |
| GET | `/ical/:icalExportToken.ics` | public (unguessable token) | Our export feed — paste into Airbnb's "Import Calendar" field |

## 4. Bookings — `/api/bookings`

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/bookings` | public | Start checkout. Body: `{ propertyId, guestName, guestEmail, guestPhone, guestIdDocumentType?, guestIdDocumentNumber?, checkIn, checkOut, guests, rooms?, childrenUnder14? }` (`rooms` defaults to 1 — only Dona's Villa has more than one option; `childrenUnder14` defaults to 0, and `400`s if it exceeds `guests`). Price is computed server-side from the property's `PricingTier` table, never taken from the request; `400` if no tier is configured for that guest/room combo. Returns `{ booking, clientSecret }`. `409 date_conflict` if dates just got taken |
| GET | `/api/bookings/:id` | public | Booking status (poll after Stripe confirmation, or for a "my booking" page) |
| GET | `/api/bookings/property/:propertyId?status=` | super_admin, villa_manager (own property) | List bookings, optional status filter |
| POST | `/api/bookings/offline` | super_admin, villa_manager (own property) | Manual/phone/walk-in booking — same body as above, no Stripe. Created as `paid_offline`. Optional `totalPriceOverride` for a negotiated rate (this overrides `accommodationPrice` only — city tax, when the property has it, is still computed from the standard tier rate and added on top, since it's a pass-through municipal fee, not part of the negotiated room price); otherwise priced the same way as a direct booking |
| POST | `/api/bookings/:id/cancel` | super_admin, villa_manager | Body: `{ refundOverride?, reason? }`. Refund defaults to the standard policy (100% ≥7 days out, 50% 3–7 days, 0% <72h) computed off `totalPrice` — which includes city tax, so a full/partial refund refunds the tax portion too (the guest never stayed, so it was never owed to the comune either); triggers a real Stripe refund on the correct account unless `refundOverride` is given |

`booking.status`: `pending_payment` → `confirmed` (via webhook) or `cancelled`
(expired hold) — or `paid_offline` for manual admin bookings.

**Price breakdown, for properties with `cityTaxEnabled`** (currently just
The Nest Bologna): every `Booking` carries `accommodationPrice` (pure room
cost — `pricePerNight × nights`), `cityTax` (computed from the property's
`cityTaxBands`, `0` when the property doesn't have city tax), and
`childrenUnder14` (as submitted, recorded for audit — the exemption math is
already baked into `cityTax` by the time it's stored). `totalPrice =
accommodationPrice + cityTax` is the amount actually charged via Stripe (or
recorded for an offline booking) — for a `cityTaxEnabled: false` property,
`accommodationPrice` and `totalPrice` are simply equal. Tax is per guest per
night, banded by the room's price *per person per night* (the underlying
rate, not whatever any one guest ends up charged), guests under
`cityTaxExemptAgeUnder` are exempt entirely, and nights beyond
`cityTaxMaxNights` stop accruing tax (the room price for those nights is
still charged in full).

## 5. Payments (webhooks only — no public endpoints)

| Method | Path | Description |
|---|---|---|
| POST | `/webhooks/stripe/italy` | Stripe webhook for The Nest Bologna's account |
| POST | `/webhooks/stripe/sri-lanka` | Stripe webhook for Dona's Villa's account |

Register both endpoints in each Stripe dashboard, subscribed to at least
`payment_intent.succeeded` and `payment_intent.payment_failed`.

## 6. Marketplace catalog — `/api/marketplace/catalog`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/marketplace/catalog/categories` | public | List categories |
| POST | `/api/marketplace/catalog/categories` | super_admin, marketplace_manager | Body: `{ name, slug? }` — `slug` is derived from `name` if omitted. `409` if the slug already exists |
| GET | `/api/marketplace/catalog/products?category=slug` | public | Active products, optional category filter |
| GET | `/api/marketplace/catalog/products/:id` | public | Single product |
| POST | `/api/marketplace/catalog/products/images` | super_admin, marketplace_manager | Upload 1–10 images (`multipart/form-data`, field name `images`, JPEG/PNG/WebP, 5MB max each). Returns `{ "urls": string[] }` — feed those straight into `images` below. Kept as a backward-compatible alias for `/api/uploads/images` — see §13.9, new code should use that instead |
| POST | `/api/marketplace/catalog/products` | super_admin, marketplace_manager | Body: `{ categoryId, name, description, priceUsd, images: string[], sku, initialStock, lowStockThreshold? }` |
| PATCH | `/api/marketplace/catalog/products/:id` | super_admin, marketplace_manager | Partial update: `name`, `description`, `priceUsd`, `images`, `active` |
| POST | `/api/marketplace/catalog/products/:id/stock-adjustment` | super_admin, marketplace_manager | Body: `{ delta }` (positive = restock, negative = manual removal) |
| GET | `/api/marketplace/catalog/low-stock` | super_admin, marketplace_manager | Products at/below their `lowStockThreshold` |

## 7. Marketplace orders — `/api/marketplace/orders`

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/marketplace/orders` | public | Guest COD checkout. Body: `{ customerName, customerPhone, deliveryAddress, notes?, shippingFee, items: [{ productId, quantity }] }` |
| GET | `/api/marketplace/orders/:id` | public | Order status lookup |
| GET | `/api/marketplace/orders?status=` | super_admin, marketplace_manager | List orders, optional status filter |
| PATCH | `/api/marketplace/orders/:id/status` | super_admin, marketplace_manager | Body: `{ status }`. Valid transitions enforced server-side (see §1.5) |

## 8. Leads — `/api/leads`

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/leads/contact` | public | Contact form. Body: `{ site: "italy"|"sri_lanka", name, email, subject: "room_booking"|"airport_transfer"|"marketplace"|"other", message }` |
| POST | `/api/leads/transport-requests` | public | Transport quote/booking. Body: `{ propertyId?, bookingId?, type: "fixed_price"|"custom_quote", date, flightNumber?, passengers, contactName, contactEmail, contactPhone, notes? }`. `bookingId` is optional — set when submitted as an add-on during villa booking checkout (see `BACKEND_CHANGES_BOOKING_TRANSPORT.md`), omitted for standalone requests from the Transport page. Not validated against `propertyId`. |
| GET | `/api/leads/contact?status=` | any admin role | Inbox |
| PATCH | `/api/leads/contact/:id/status` | any admin role | Body: `{ status: "new"|"read"|"responded" }` |
| GET | `/api/leads/transport-requests?status=` | any admin role | Inbox. Each row includes `bookingId` (nullable). |
| PATCH | `/api/leads/transport-requests/:id/status` | any admin role | Body: `{ status }` |
| POST | `/api/leads/newsletter` | public | Body: `{ email, site: "italy"|"sri_lanka" }`. `201` on success, `409` if that email is already subscribed *for that site* (subscribing to both sites independently is fine — same email, different `site`, no conflict) |
| GET | `/api/leads/newsletter?site=` | any admin role | List subscribers, optional site filter |

## 9. Offers — `/api/offers`

Per-property discount banners — replaces what used to be a hardcoded "48% OFF"
card on both homepages. The frontend fetches all offers for a property and
shows whichever one has `active: true`. At most one offer per property can be
`active` at a time — creating or updating one with `active: true` silently
deactivates any other active offer for that same property (transactional, so
a concurrent request can't observe two active offers even momentarily).

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/offers?propertyId=` | public | List offers for one property. `400` if `propertyId` is omitted |
| POST | `/api/offers` | super_admin, villa_manager (own property) | Body: `{ propertyId, title, discountPercent, imageUrl?, active? }` |
| PATCH | `/api/offers/:id` | super_admin, villa_manager (own property) | Partial update — also how the Activate/Deactivate toggle works (`{ active: boolean }`). Which property an offer belongs to is resolved server-side from the offer itself (not the URL), so a villa_manager gets `403` on another property's offer even though `propertyId` isn't in this route |
| DELETE | `/api/offers/:id` | super_admin, villa_manager (own property) | Same scoping as `PATCH` |

## 10. Blog — `/api/blog`

Per-site posts (an Italy post never appears on the Sri Lanka site), admin-authored,
draft/publish workflow via `publishedAt`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/blog/posts?site=` | public, or super_admin with a token | **Without** a valid admin token: published-only (`publishedAt` not null), most recent first. **With** a `super_admin` token: drafts included too, and `site` becomes optional (omit it to list across both sites). Same path and handler either way — it branches on whether the request carried a valid token, not on a separate admin route |
| GET | `/api/blog/posts/:slug` | public | Single published post. `404` if the slug doesn't exist *or* the post is an unpublished draft — drafts are never reachable by direct slug, even for someone who knows/guesses it |
| POST | `/api/blog/posts` | super_admin | Body: `{ site, title, slug?, excerpt, body, coverImageUrl?, author, publishedAt? }`. `slug` auto-derives from `title` if omitted (same slugify rule as marketplace categories). Omit `publishedAt` (or send `null`) to create a draft |
| PATCH | `/api/blog/posts/:id` | super_admin | Partial update. Setting `publishedAt` to a timestamp publishes it; setting it to `null` unpublishes it; omitting the field entirely leaves it as-is |
| DELETE | `/api/blog/posts/:id` | super_admin | |

Only `super_admin` manages blog content — posts aren't cleanly scoped to one
property or the marketplace the way `villa_manager`/`marketplace_manager`
are, so this is deliberately not role-split further for now.

## 11. Admin — `/api/admin`

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/admin/login` | public | Body: `{ email, password }` → `{ admin, accessToken, refreshToken }` |
| POST | `/api/admin/refresh` | public | Body: `{ refreshToken }` → new token pair |
| GET | `/api/admin/me` | any admin | Current admin identity from the access token |
| GET | `/api/admin/dashboard` | any admin | Upcoming check-ins/outs (next 7 days), revenue per property, low-stock count, pending-orders count |
| POST | `/api/admin/users` | super_admin | Create an admin account. Body: `{ email, password, role, propertyScopeId? }` — there is no public signup route |
| GET | `/api/admin/users` | super_admin | List all admin accounts (`id, email, role, propertyScopeId, createdAt` — never `passwordHash`) |
| DELETE | `/api/admin/users/:id` | super_admin | Remove an admin account. `400` if you try to delete the account you're currently authenticated as (avoids stranding your own session with no other super_admin to undo it); `404` if the id doesn't exist. No "last super_admin" guard — it's possible to delete every super_admin account, so be deliberate |

## 12. Guest info requests — `/api/admin/guest-info-template`, `/api/bookings/:id/info-requests`, `/api/booking-info-requests`

Lets an admin send a booked guest a link, by email, to a short form
collecting whatever extra info is needed before their stay (passport number,
arrival flight, dietary requirements, etc.) — no guest login/account system.
Full design in `BACKEND_CHANGES_GUEST_INFO_REQUESTS.md`.

**Flow:** admin edits a shared question list once (the template) → clicks
"Request Guest Info" on a booking, which snapshots the *current* template
into a new `BookingInfoRequest` row, generates a `token`, and emails the
guest a link (`{FRONTEND_URL}/booking-info/{token}`) → guest opens the link,
no login, fills the form, submits once (no edit-after-submit — a correction
means the admin sends a fresh link, which creates a new row/token) → admin
sees the answers back on the booking. Editing the template later never
changes a link already sent, since each request carries its own frozen copy
of the fields it was sent with. Manual trigger only — no scheduled job.

A `BookingInfoRequest.status` of `pending` reads as `expired` once
`expiresAt` (14 days after creation) has passed — computed on every read,
not by a background job, so nothing needs to run for it to be accurate.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/admin/guest-info-template` | super_admin | Returns `{ fields, updatedAt }`, the shared question list. `{ fields: [], updatedAt: null }` if never set — not a `404` |
| PUT | `/api/admin/guest-info-template` | super_admin | Body: `{ fields }` — upserts the single shared row. `fields` is `{ id, label, type: "text"\|"textarea"\|"date"\|"number"\|"select"\|"checkbox"\|"file", required, options? }[]`; `id` is client-generated and stable per field (it's the key answers get stored under). `"file"` collects a document — see the uploads endpoint below |
| POST | `/api/bookings/:id/info-requests` | super_admin, villa_manager (own property) | Creates a `BookingInfoRequest`: snapshots the current template's `fields`, generates a `token`, sets a 14-day `expiresAt`, and emails the guest. Returns the created row **including `token`/`link`** — the admin UI's "Copy Link" button uses it as a manual fallback (WhatsApp etc.) if the email doesn't land. `404` if the booking doesn't exist; `403` if a villa_manager doesn't own its property |
| GET | `/api/bookings/:id/info-requests` | super_admin, villa_manager (own property) | Lists all requests for this booking, most recent first (more than one if the admin re-sent). Same scoping as `POST` |
| GET | `/api/booking-info-requests/:token` | public | Everything the guest-facing form needs in one call: `{ status, propertyName, guestName, checkIn, checkOut, fields, expiresAt }`. `404` if the token doesn't exist at all; a lapsed-but-real token still returns `200` with `status: "expired"` (a friendly message, not a hard error) — the token/link itself is never echoed back here, there's nothing to expose |
| POST | `/api/booking-info-requests/:token/uploads` | public | Multipart body, files under a repeatable `files` field. Uploads immediately as the guest picks a file, before submit (same UX as the admin product-image dropzone) — not bundled as raw bytes into the `submit` payload below. Returns `{ urls: string[] }`; feed those into the matching `"file"` field's answer. JPEG/PNG/WebP/PDF only, 10MB/file, enforced server-side regardless of the frontend's `accept` attribute. Same status gating as `submit`: `404` unknown token, `409` if already submitted, `410` if expired |
| POST | `/api/booking-info-requests/:token/submit` | public | Body: `{ answers: { [fieldId]: string \| boolean \| string[] } }` — a `"file"` field's answer is the `urls` array from the uploads endpoint above. Every `required` field (per the row's own snapshotted `fields`) must have a non-empty answer (a non-empty array counts, for `"file"`), else `400`. On success: stores `answers`, sets `status: "submitted"`. `404` unknown token, `409` if already submitted, `410` if expired |

No customer accounts, no sessions — knowing the token *is* the access
control, same trust model as `Property.icalExportToken` elsewhere in this
API. Uploaded documents go to the same S3/R2 bucket as `/api/uploads/images`
(§13.9), under a `guest-documents/` prefix.

---

## 13. Frontend integration checklist

Things a frontend needs to know that aren't obvious from the endpoint list above.

### 13.1 Stripe publishable keys — not provided by this API

This backend only ever holds Stripe **secret** keys, server-side
(`STRIPE_ITALY_SECRET_KEY` / `STRIPE_SRILANKA_SECRET_KEY`). To initialize
Stripe.js in the browser, the frontend needs its own **publishable** keys
(`pk_test_...` / `pk_live_...`) — one per Stripe account, matched to the same
`italy` / `sri_lanka` pairing the backend uses. Get each from that account's
dashboard → **Developers → API keys → Publishable key**, and store them as
two frontend env vars (e.g. `NEXT_PUBLIC_STRIPE_PK_ITALY`,
`NEXT_PUBLIC_STRIPE_PK_SRILANKA`), picking the right one based on which
property the guest is booking (`property.stripeAccountRef`). A mismatched
publishable/secret key pair (frontend using the wrong account's key) fails
with a "No such payment_intent" error client-side — the two keys must come
from the *same* Stripe account.

### 13.2 Confirming payment — use the Payment Element, and pass a `return_url`

PaymentIntents are created with `automatic_payment_methods: { enabled: true }`
(default `allow_redirects: "always"`), so each one's `payment_method_types`
includes whatever's enabled in that Stripe account's dashboard — typically
card plus redirect-based methods (Klarna, Cashapp, Affirm, Amazon Pay, Link).
Use Stripe's **Payment Element** (`stripe.confirmPayment`), not the legacy
Card Element, so the UI adapts to whatever's actually enabled. `confirmPayment`
**requires a `return_url`** in `confirmParams` (where Stripe sends the guest
back after a redirect-based method) — omitting it fails the call. If you'd
rather avoid redirect flows entirely, that's a change to make in the Stripe
Dashboard (restrict enabled payment methods) or ask for a backend change to
set `allow_redirects: "never"` in `payments/service.ts` — not something to
work around purely in the frontend.

### 13.3 Booking confirmation is asynchronous — poll after `confirmPayment`

`stripe.confirmPayment()` resolving successfully in the browser does **not**
mean `booking.status` is `confirmed` yet — that only happens once Stripe's
webhook lands and the backend processes it (normally near-instant, but not
synchronous with the client-side call). After `confirmPayment` succeeds,
poll `GET /api/bookings/:id` (e.g. every 1–2s, give up after ~15s) until
`status` becomes `confirmed`, rather than assuming it's done immediately. A
timeout there most likely means the webhook is just running slightly behind,
not that anything failed — word the UI accordingly rather than showing an error.

### 13.4 The hold has a countdown — show it, and handle expiry gracefully

`POST /api/bookings` returns `booking.expiresAt` (15 minutes out by default,
`BOOKING_HOLD_MINUTES`). If checkout isn't completed by then, a cron job
silently cancels the hold and frees the dates — the guest's `confirmPayment`
call will then fail (or succeed but land on an already-cancelled booking on
the next poll). Show a visible countdown during checkout, and if payment
fails after the hold appears to have expired, message it as "your hold
expired, please start again" rather than a generic payment error.

### 13.5 Room selection only exists for Dona's Villa

`guests` + `rooms` (optional in the request, defaults to `1`) together select
the exact `PricingTier` row. Fetch `GET /api/properties/:slug` and use its
`pricingTiers` array (`{ guestCount, rooms, pricePerNight }[]`) to build the
guest-count selector — group by `guestCount` to see whether more than one
`rooms` option exists for that party size. Right now that's only ever true
for `donas-villa`; `the-nest-bologna` has exactly one `rooms: 1` tier per
guest count, so no room selector is needed there. Never compute or send a
price yourself — the server always derives `totalPrice` from whichever
`(guestCount, rooms)` tier matches, and returns `400` if no tier exists for
that combination (show that message directly; it means the UI offered an
invalid guest/room combo).

### 13.6 Currency is per-property

`property.currency` is `"eur"` for The Nest Bologna and `"usd"` for Dona's
Villa — format guest-facing prices accordingly (`€` vs `$`), don't hardcode
one currency site-wide. `Booking.currency` in every booking response always
matches `property.currency`.

### 13.7 Dates: send plain `YYYY-MM-DD`, not full ISO timestamps

`checkIn`/`checkOut` are stored as dates only, no time component. Sending a
full ISO datetime risks the calendar date shifting by a day once converted to
UTC (e.g. a late-evening Sri Lanka timestamp rolling into the next UTC day).
Always send plain date strings, e.g. `"2026-08-01"`.

### 13.8 CORS

`CORS_ORIGIN` in the backend's `.env` must exactly match the frontend's
origin (`src/app.ts` → `cors({ origin: env.corsOrigin })`, currently only a
single origin string, no allowlist). Defaults to `http://localhost:3000` for
local dev — update it before deploying if the production frontend domain
differs.

### 13.9 Image upload

`POST /api/uploads/images` is the one shared upload endpoint — used by the
product catalog, offers, and blog alike. It proxies the upload through this
backend to S3/R2, so the frontend never talks to the storage provider
directly and there's no separate CORS setup needed on that side. Auth is any
admin role (`super_admin`, `villa_manager`, or `marketplace_manager`) — not
gated to one feature.

- Send `multipart/form-data`, **field name must be `images`** (matches
  `multer`'s `upload.array("images", 10)` on the backend) — up to 10 files,
  5MB each, JPEG/PNG/WebP only. Anything else is rejected with `400`.
- Response: `{ "urls": [...] }`, same order as the files were sent.
- Feed the returned URLs straight into whichever feature's `imageUrl` /
  `coverImageUrl` / `images` field — upload first (e.g. as the admin
  picks/drops files, with previews), then submit the rest of the form with
  the resolved URLs already in hand.
- Typical flow with `fetch`:
  ```js
  const formData = new FormData();
  for (const file of selectedFiles) formData.append("images", file);

  const res = await fetch("/api/uploads/images", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` }, // no Content-Type — let the browser set the multipart boundary
    body: formData,
  });
  const { urls } = await res.json();
  ```
- Uploaded files are **not** deleted from storage when whatever referenced
  them is edited or removed — orphaned files just sit in the bucket. Not a
  functional problem, only a storage-cost one; ask if you want cleanup added
  later.
- Requires `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_URL` set in the backend's `.env` (see
  `.env.example`) — until then the endpoint returns
  `400 "Image upload is not configured"`.

`POST /api/marketplace/catalog/products/images` (super_admin/marketplace_manager
only) still exists and works identically — kept as a backward-compatible
alias since it already had a working integration. New frontend code should
use `/api/uploads/images` instead; there's no reason to add more
feature-specific upload routes going forward.

---

## 14. Error shape

```json
{ "error": "date_conflict", "message": "These dates are no longer available for this property." }
```

Validation errors (Zod) return `400` with
`{ "error": "validation_error", "message": "Request failed validation", "details": [{ "path": "body.guestEmail", "message": "Required" }, ...] }`
— `path` is dot-joined, prefixed with `body`/`query`/`params` per where the
field lives in the request.

## 15. Not yet wired (see BACKEND_PLAN.md for context)

- WhatsApp transfer confirmations (currently a manual admin action, per plan §11)
- Government ID-export endpoint for Italy/Sri Lanka compliance filing (data is captured on `Booking`, export route not yet built)
