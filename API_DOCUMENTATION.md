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
`availability_blocks` (`source`: `direct` | `airbnb` | `manual`), each row
optionally scoped to one `Room` (`room_id`, nullable — see §3). **Whole-villa
locking**: only one party occupies a room-enabled property (Dona's Villa) at
a time, so a block on *any* room now makes the *whole* property unavailable
— booking one room blocks the other two as well, not just the one reserved.
`room_id` is still recorded per block (useful for admin display — which
room a block/booking is actually for) but isn't consulted when computing
availability. (A property with no rooms configured — The Nest Bologna —
already only ever books as a single unit, so this is a no-op there.)

Two Postgres **exclusion constraints** make it physically impossible for
two active rows to conflict, enforced by the database itself so it holds
even under concurrent requests, not just at the application layer: one
guarantees two rows belonging to *different* bookings never overlap
(`bookingId <>`, only comparable when both are set), the other guarantees
two rows with *no* booking (manual blocks, Airbnb imports) never overlap.
The exemption that makes room-booking possible in the first place — a
single booking's own several per-room blocks, which share one `bookingId`
and the same date range, must *not* conflict with each other — falls out of
using `bookingId` rather than `roomId` as the differentiator. The one case
a database constraint can't express — a booking's block(s) landing at the
same instant as an existing manual/Airbnb block — is checked at the
application level instead, inside the same transaction as the write; see
`SUPABASE_SETUP.md` for the exact SQL and the full reasoning.

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
| GET | `/api/properties/:slug` | public | Get one property by slug (`the-nest-bologna`, `donas-villa`). Includes a `rooms` array (active rooms, sorted by `sortOrder`) for a property that has any configured — see §3. Empty array for one that doesn't (The Nest Bologna) |
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
there's no admin UI for editing these yet. See §6 for how they turn into an
actual charge on a booking.

## 3. Rooms — `/api/properties/:propertyId/rooms`, `/api/rooms`

Individually-bookable rooms (Dona's Villa) — a guest picks specific room(s)
instead of just a room *count*, pricing is per-room (§6), and everything
here is fully admin-configurable (no hardcoded room names/photos anywhere).
**Additive and optional**: a property with zero `Room` rows (The Nest
Bologna) keeps booking as a single unit via `PricingTier` exactly as it
always has — nothing below applies to it. Availability, on the other hand,
is whole-property even for a room-enabled property — booking any room(s)
blocks the other rooms too, see §1.1 and §5 — so "individually-bookable"
here means *which room*, not *independent availability per room*. See
`BACKEND_CHANGES_SRI_LANKA_ROOMS.md` for the original design and
`BACKEND_CHANGES_PRICING_DISCOUNTS_SHIPPING.md` §3 for the whole-villa-
locking reversal on top of it.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/properties/:propertyId/rooms` | public, or super_admin/`villa_manager` scoped to this property with a token | Active rooms, sorted by `sortOrder`. `?includeInactive=true` also returns retired (`active: false`) rooms — only honored with a valid admin token scoped to this property, silently ignored (falls back to active-only) otherwise. Same branch-on-token pattern as blog's `GET /api/blog/posts` (§12) |
| POST | `/api/properties/:propertyId/rooms` | super_admin, `villa_manager` (own property) | Body: `{ name, subtitle?, capacity, pricePerNight, images?, sortOrder? }`. `201` with the created `Room`. `images` are uploaded first through the existing shared upload flow (`POST /api/uploads/images`), same as products/offers/blog — this endpoint just takes the resulting URLs |
| PATCH | `/api/rooms/:roomId` | super_admin, `villa_manager` (own property) | Partial update: any subset of `{ name, subtitle, capacity, pricePerNight, images, sortOrder, active }`. Setting `active: false` retires a room — hides it from the public list and blocks new bookings against it, without touching any booking that already references it |
| DELETE | `/api/rooms/:roomId` | super_admin, `villa_manager` (own property) | `404` if it doesn't exist. `409` if any non-cancelled booking's `roomIds` still references it — deactivate instead (`PATCH { active: false }`), same "can't delete, has history" guard used elsewhere in this API (e.g. marketplace products) |

## 4. Rate overrides — `/api/properties/:propertyId/rate-overrides`, `/api/rate-overrides`

Seasonal/date-range price overrides — an admin sets a different nightly
rate for a specific date or date range without touching the base rate that
applies everywhere else. Guests never see a calendar of these, only the
resolved price for whatever dates they've actually picked — see §6 for
exactly how a night's price gets resolved. See
`BACKEND_CHANGES_PRICING_DISCOUNTS_SHIPPING.md` §1 for the full design.

Exactly one of `roomId` or `(guestCount, rooms)` is set per row, matching
whichever pricing model the property uses — `roomId` for a room-based
property (Dona's Villa), `(guestCount, rooms)` referencing an existing
`PricingTier` for a tier-based one (The Nest Bologna). `endDate` is
inclusive (unlike `AvailabilityBlock`'s half-open range) — an admin picks a
range like a normal date field.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/properties/:propertyId/rate-overrides` | public | All of the property's rate overrides, sorted by `startDate` |
| POST | `/api/properties/:propertyId/rate-overrides` | super_admin, `villa_manager` (own property) | Body: `{ roomId?, guestCount?, rooms?, startDate, endDate, pricePerNight }`. `400` if neither or both of `roomId`/`(guestCount, rooms)` are set, if `roomId` doesn't belong to this property, or if `(guestCount, rooms)` doesn't match an existing `PricingTier` on this property. `201` with the created row |
| PATCH | `/api/rate-overrides/:id` | super_admin, `villa_manager` (own property) | Any subset of the create fields. Re-validates the same rules as create against the merged (existing + patch) result — a `PATCH` that only changes `pricePerNight` still has to resolve to a valid target |
| DELETE | `/api/rate-overrides/:id` | super_admin, `villa_manager` (own property) | Hard delete — no history concern here (unlike rooms/products), an override is just a price rule, not something referenced by past bookings |

## 5. Availability — `/api/availability`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/availability/:propertyId?from=YYYY-MM-DD&to=YYYY-MM-DD` | public | Active blocks (direct + Airbnb + manual) for the read-only calendar. Each block includes `roomId` — `null` for a whole-property block, set for one scoped to a single room (§3) |
| POST | `/api/availability/:propertyId/blocks` | super_admin, villa_manager (own property) | Manual block. Body: `{ "startDate", "endDate", "reason"?, "roomId"? }` — `roomId` is recorded (which room a maintenance block is "for", shown in the admin Blocks tab) but doesn't change what it actually blocks: whole-villa locking (§1.1) means any block, room-specific or not, makes the *entire* property unavailable for those dates. `409` if it overlaps *any* existing active block on the property, regardless of room |
| DELETE | `/api/availability/blocks/:blockId` | super_admin, villa_manager | Release a manual block |
| GET | `/ical/:icalExportToken.ics` | public (unguessable token) | Our export feed — paste into Airbnb's "Import Calendar" field |

## 6. Bookings — `/api/bookings`

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/bookings` | public | Start checkout. Body: `{ propertyId, guestName, guestEmail, guestPhone, guestIdDocumentType?, guestIdDocumentNumber?, checkIn, checkOut, guests, rooms?, childrenUnder14?, roomIds? }`. Price is always computed server-side, never taken from the request, **per night** (see below), and branches on whether the property has any `Room` rows configured (§3): **with** rooms (Dona's Villa) — `roomIds` is required (non-empty), every id must belong to this property and be active, their combined `capacity` must cover `guests`; `rooms` is derived from `roomIds.length` server-side, not trusted from the client. **Without** rooms (The Nest Bologna) — unchanged: `rooms` defaults to 1, `400` if no `PricingTier` is configured for that guest/room combo, and `roomIds` must be omitted (`400` if sent). `childrenUnder14` defaults to 0 and `400`s if it exceeds `guests`, same either way. Returns `{ booking, clientSecret }`. `409 date_conflict` if dates (or, for a room-booking, the whole property — see §1.1) just got taken |
| GET | `/api/bookings/:id` | public | Booking status (poll after Stripe confirmation, or for a "my booking" page) |
| GET | `/api/bookings/property/:propertyId?status=` | super_admin, villa_manager (own property) | List bookings, optional status filter |
| POST | `/api/bookings/offline` | super_admin, villa_manager (own property) | Manual/phone/walk-in booking — same body as above (including the room-booking branch), no Stripe. Created as `paid_offline`. Optional `totalPriceOverride` for a negotiated rate (this overrides `accommodationPrice` only — city tax, when the property has it, is still computed from the standard rate and added on top, since it's a pass-through municipal fee, not part of the negotiated room price); otherwise priced the same way as a direct booking |
| POST | `/api/bookings/:id/cancel` | super_admin, villa_manager | Body: `{ refundOverride?, reason? }`. Refund defaults to the standard policy (100% ≥7 days out, 50% 3–7 days, 0% <72h) computed off `totalPrice` — which includes city tax, so a full/partial refund refunds the tax portion too (the guest never stayed, so it was never owed to the comune either); triggers a real Stripe refund on the correct account unless `refundOverride` is given |

`booking.status`: `pending_payment` → `confirmed` (via webhook) or `cancelled`
(expired hold) — or `paid_offline` for manual admin bookings.

**Pricing is resolved per night**, not as `nights × one flat rate` — each
night of the stay independently resolves to a price, and those are summed:

1. Start from the base rate for that night — a room's own `pricePerNight`
   (room-booking) or the matched `PricingTier.pricePerNight` (tier-based).
2. If a `RateOverride` (§4) for that room (or that `guestCount`/`rooms`
   pair) covers that night's date, its `pricePerNight` replaces the base
   rate for that one night only.
3. If any `active: true` `Offer` (§11) for the property — with no date
   range, or a date range covering that night — matches, the *highest*
   matching `discountPercent` is taken off that night's price (post-step-2,
   pre-discount rate); offers don't stack.
4. City tax, when `cityTaxEnabled`, is banded per night off the step-2
   result (post-`RateOverride`, *pre*-discount) — a promotional discount
   doesn't change what the comune considers the underlying rate, same
   reasoning already applied to `totalPriceOverride` below.

`accommodationPrice` is the sum of every night's step-3 result;
`totalPrice = accommodationPrice + cityTax`, same as always. A property
with no `RateOverride`/`Offer` rows configured resolves to exactly the old
flat-rate behavior for every night — this is additive, not a rewrite of
what an unconfigured property already does.

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

## 7. Payments (webhooks only — no public endpoints)

| Method | Path | Description |
|---|---|---|
| POST | `/webhooks/stripe/italy` | Stripe webhook for The Nest Bologna's account |
| POST | `/webhooks/stripe/sri-lanka` | Stripe webhook for Dona's Villa's account |

Register both endpoints in each Stripe dashboard, subscribed to at least
`payment_intent.succeeded` and `payment_intent.payment_failed`.

## 8. Marketplace catalog — `/api/marketplace/catalog`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/marketplace/catalog/categories` | public | List every category — no filtering on `featured`, this is also what the full marketplace product listing's category filter uses. Includes `description`, `imageUrl`, `featured` |
| POST | `/api/marketplace/catalog/categories` | super_admin, marketplace_manager | Body: `{ name, slug?, description?, imageUrl?, featured? }` — `slug` is derived from `name` if omitted. `409` if the slug already exists, or if this would put more than 4 categories at `featured: true` at once |
| PATCH | `/api/marketplace/catalog/categories/:id` | super_admin, marketplace_manager | Any subset of `{ name, description, imageUrl, featured }`. `404` if it doesn't exist, `409` on the same 4-featured-max rule as create (re-saving a category that's already one of the 4 doesn't count against itself) |
| DELETE | `/api/marketplace/catalog/categories/:id` | super_admin, marketplace_manager | `404` if it doesn't exist. `409` if it still has any products — delete or move them first, no cascade |
| GET | `/api/marketplace/catalog/products?category=slug` | public, or super_admin/marketplace_manager with a token | **Without** a valid admin token: active products only (the storefront). **With** a `super_admin`/`marketplace_manager` token: inactive products included too. Same path/handler either way — branches on whether the request carried a valid token, same pattern as blog's `GET /api/blog/posts` (§12). `?category=` filter applies in both cases |
| GET | `/api/marketplace/catalog/products/:id` | public, or super_admin/marketplace_manager with a token | Single product. Same admin branch as the list above — an inactive product `404`s without a valid admin token |
| POST | `/api/marketplace/catalog/products/images` | super_admin, marketplace_manager | Upload 1–10 images (`multipart/form-data`, field name `images`, JPEG/PNG/WebP, 5MB max each). Returns `{ "urls": string[] }` — feed those straight into `images` below. Kept as a backward-compatible alias for `/api/uploads/images` — see §16.9, new code should use that instead |
| POST | `/api/marketplace/catalog/products` | super_admin, marketplace_manager | Body: `{ categoryId, name, description, priceUsd, images: string[], sku, initialStock, lowStockThreshold?, weightKg? }` — `weightKg` (kg per single unit) feeds shipping-fee calculation (§9); omitted/absent is treated as 0kg |
| PATCH | `/api/marketplace/catalog/products/:id` | super_admin, marketplace_manager | Partial update: `categoryId`, `name`, `description`, `priceUsd`, `images`, `active`, `weightKg` — `categoryId` lets a product move to a different category, e.g. to empty one out before deleting it |
| DELETE | `/api/marketplace/catalog/products/:id` | super_admin, marketplace_manager | `404` if it doesn't exist. `409` if it has any order history (real orders reference it) — deactivate instead (`PATCH { active: false }`), which already hides it from the storefront without touching order records. A never-ordered product deletes cleanly, its stock row goes with it |
| POST | `/api/marketplace/catalog/products/:id/stock-adjustment` | super_admin, marketplace_manager | Body: `{ delta }` (positive = restock, negative = manual removal) |
| GET | `/api/marketplace/catalog/low-stock` | super_admin, marketplace_manager | Products at/below their `lowStockThreshold` |

## 9. Marketplace orders & shipping — `/api/marketplace/orders`, `/api/marketplace/shipping-rates`

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/marketplace/orders` | public | Guest COD checkout. Body: `{ customerName, customerPhone, deliveryAddress, notes?, items: [{ productId, quantity }] }`. `shippingFee` is **computed server-side** from the items' weight and the current `ShippingRate` table (below) — never taken from the request (closes a gap `BACKEND_PLAN.md` §7 left open, where it used to be a flat, client-supplied value; a `shippingFee` in the request body is now silently ignored) |
| GET | `/api/marketplace/orders/:id` | public | Order status lookup |
| GET | `/api/marketplace/orders?status=` | super_admin, marketplace_manager | List orders, optional status filter |
| PATCH | `/api/marketplace/orders/:id/status` | super_admin, marketplace_manager | Body: `{ status }`. Valid transitions enforced server-side (see §1.5) |
| GET | `/api/marketplace/shipping-rates` | public | List the current price-per-kg bands (`{ fromKg, toKg, pricePerKg }[]`), sorted by `fromKg` — checkout needs to price shipping before the customer has any session |
| PUT | `/api/marketplace/shipping-rates` | super_admin, marketplace_manager | Body: `{ rates: [{ fromKg, toKg, pricePerKg }, ...] }` — **bulk replace** (delete-all-then-recreate in one transaction, not an upsert — rows have no natural stable identity to upsert against, since an admin reconfiguring the bands can freely change how many exist and where they start/end). Returns the full new list |

**Shipping fee calculation**: `totalWeightKg = Σ(product.weightKg × quantity)`
across the order's items (a product with no `weightKg` set counts as 0kg),
rounded **up** to the nearest whole kg, minimum 1kg once the cart is
non-empty (even an all-0kg cart still gets charged the 1kg band). Find the
`ShippingRate` row where `fromKg <= totalWeightKg <= toKg`; the fee is
`totalWeightKg × that row's pricePerKg` — the *whole* weight at that one
band's rate, not a blend across bands. If the rounded weight exceeds every
row's `toKg`, the highest row's `pricePerKg` prices the excess (symmetrically,
a weight below every row's `fromKg` uses the lowest row's rate) — there's no
data to price it any other way until the admin adds more rows. If no
`ShippingRate` rows are configured at all, the fee is `0` rather than
silently trusting a client-sent value (the trust gap being closed above) or
guessing at a fallback constant.

## 10. Leads — `/api/leads`

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

## 11. Offers — `/api/offers`

Per-property discount banners — replaces what used to be a hardcoded "48% OFF"
card on both homepages, and (once an `active` offer has a date range —
below) actually reduces the accommodation price at checkout too, not just a
marketing card. The frontend fetches all offers for a property and shows
whichever one has `active: true`. At most one offer per property can be
`active` at a time — creating or updating one with `active: true` silently
deactivates any other active offer for that same property (transactional, so
a concurrent request can't observe two active offers even momentarily).

`startDate`/`endDate` (both nullable, always set/cleared together): omitted
on either means "no date limit," so an `active` offer applies to every
night of every stay, same as before this field existed. When set, only
matches a night whose date falls within `[startDate, endDate]` when
resolving the per-night discount (§6) — a stay with nights outside that
range gets the discount only on the nights that fall inside it. **Because
at most one offer can be `active` per property, only one offer's discount
can ever actually apply at once in practice today** — the "highest
matching %" resolution logic in §6 exists for when that changes, not
because it currently does anything with more than one row.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/offers?propertyId=` | public | List offers for one property. `400` if `propertyId` is omitted |
| POST | `/api/offers` | super_admin, villa_manager (own property) | Body: `{ propertyId, title, discountPercent, imageUrl?, active?, startDate?, endDate? }` |
| PATCH | `/api/offers/:id` | super_admin, villa_manager (own property) | Partial update — also how the Activate/Deactivate toggle works (`{ active: boolean }`), and how `startDate`/`endDate` get set or cleared (send `null` to clear either back to "no date limit"). Which property an offer belongs to is resolved server-side from the offer itself (not the URL), so a villa_manager gets `403` on another property's offer even though `propertyId` isn't in this route |
| DELETE | `/api/offers/:id` | super_admin, villa_manager (own property) | Same scoping as `PATCH` |

## 12. Blog — `/api/blog`

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

## 13. Admin — `/api/admin`

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/admin/login` | public | Body: `{ email, password }` → `{ admin, accessToken, refreshToken }` |
| POST | `/api/admin/refresh` | public | Body: `{ refreshToken }` → new token pair |
| GET | `/api/admin/me` | any admin | Current admin identity from the access token |
| GET | `/api/admin/dashboard` | any admin | Upcoming check-ins/outs (next 7 days), revenue per property, low-stock count, pending-orders count |
| POST | `/api/admin/users` | super_admin | Create an admin account. Body: `{ email, password, role, propertyScopeId? }` — there is no public signup route |
| GET | `/api/admin/users` | super_admin | List all admin accounts (`id, email, role, propertyScopeId, createdAt` — never `passwordHash`) |
| DELETE | `/api/admin/users/:id` | super_admin | Remove an admin account. `400` if you try to delete the account you're currently authenticated as (avoids stranding your own session with no other super_admin to undo it); `404` if the id doesn't exist. No "last super_admin" guard — it's possible to delete every super_admin account, so be deliberate |

## 14. Guest info requests — `/api/admin/guest-info-template`, `/api/bookings/:id/info-requests`, `/api/booking-info-requests`

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
(§16.9), under a `guest-documents/` prefix.

---

## 15. Analytics / click heatmaps — `/api/analytics`

A Plerdy/Hotjar-style click heatmap: a collector on every public page (never
`/admin/*`) beacons each click's normalized position back here; the admin
"Heatmap" tab (`super_admin` only) renders the target page in an iframe with
a canvas heat overlay built from the aggregated result. See
`BACKEND_CHANGES_HEATMAP_ANALYTICS.md` for the full design, including the
raw `ClickEvent` schema.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/analytics/click-events` | public, rate-limited (300/min/IP) | High-volume, fire-and-forget ingest — hit directly by every visitor's browser (`sendBeacon`/`fetch`, not `authedFetch`), never `authedFetch`'d. Body: `{ events: [{ site?, path, xPct, yPct, viewportWidth, device, sessionId, targetSelector?, occurredAt }] }`, up to 50 events per request (extra ones are silently truncated, not rejected). `xPct`/`yPct` are clamped server-side to `[0, 1]` regardless of what the client sends. **Always responds `202`**, even for a malformed event, an over-the-rate-limit request, or a request whose `Origin`/`Referer` doesn't match this site's own domains — a real visitor's browser must never see an error here, and there's nothing it could do about one anyway. A rejected/malformed event is just silently not recorded, never surfaced |
| GET | `/api/analytics/heatmap?path=&device=&from=&to=` | `super_admin` | `path` required; `device` is `all` (default) \| `desktop` \| `tablet` \| `mobile`; `from`/`to` are `YYYY-MM-DD`, inclusive on both ends. Aggregates `ClickEvent` rows at read time (no separate rollup table — traffic here doesn't warrant one yet) into a 100×100 grid (`xPct`/`yPct` rounded to 2 decimals) matching the resolution the frontend's canvas renderer expects. Returns `{ site, path, device, from, to, totalClicks, totalPageViews, maxWeight, points: [{ xPct, yPct, weight }] }` — `totalPageViews` is `count(distinct sessionId)` in range (a "page view" here means a distinct visiting session, not a separate pageview-tracking system), `maxWeight` is the highest single point's weight, for the frontend to normalize color/opacity against |
| GET | `/api/analytics/heatmap/pages?site=` | `super_admin` | Every distinct `path` seen so far (optionally filtered to one `site`), with an all-time, all-device click count — purely cosmetic, annotates the admin page-picker dropdown. `{ site, path, label, clicks }[]`, `label` just echoes `path` |

`ClickEvent` rows are deleted once they're older than **180 days** by a
daily cron job (`src/jobs/clickEventRetention.ts`) — raw rows are only ever
read in aggregate and nothing on the frontend requests a range past 90 days,
so 180 gives headroom without keeping data indefinitely. No visitor-
identifying data is collected today (`sessionId` is a random per-tab id, not
an account or fingerprint) — if that ever changes, keep it out of anything
the admin dashboard reads back, and check it against this site's privacy
policy pages first.

---

## 16. Frontend integration checklist

Things a frontend needs to know that aren't obvious from the endpoint list above.

### 16.1 Stripe publishable keys — not provided by this API

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

### 16.2 Confirming payment — use the Payment Element, and pass a `return_url`

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

### 16.3 Booking confirmation is asynchronous — poll after `confirmPayment`

`stripe.confirmPayment()` resolving successfully in the browser does **not**
mean `booking.status` is `confirmed` yet — that only happens once Stripe's
webhook lands and the backend processes it (normally near-instant, but not
synchronous with the client-side call). After `confirmPayment` succeeds,
poll `GET /api/bookings/:id` (e.g. every 1–2s, give up after ~15s) until
`status` becomes `confirmed`, rather than assuming it's done immediately. A
timeout there most likely means the webhook is just running slightly behind,
not that anything failed — word the UI accordingly rather than showing an error.

### 16.4 The hold has a countdown — show it, and handle expiry gracefully

`POST /api/bookings` returns `booking.expiresAt` (15 minutes out by default,
`BOOKING_HOLD_MINUTES`). If checkout isn't completed by then, a cron job
silently cancels the hold and frees the dates — the guest's `confirmPayment`
call will then fail (or succeed but land on an already-cancelled booking on
the next poll). Show a visible countdown during checkout, and if payment
fails after the hold appears to have expired, message it as "your hold
expired, please start again" rather than a generic payment error.

### 16.5 Two different "room" concepts — check `property.rooms` first

Check `GET /api/properties/:slug`'s `rooms` array (§3) before deciding which
picker to render — it's non-empty only for a property that's been
individually-room-enabled (Dona's Villa, once an admin has created rooms
for it through the Rooms tab; empty until then, and always empty for The
Nest Bologna).

- **`property.rooms` is non-empty** (individually-bookable rooms): show the
  room picker described in `BACKEND_CHANGES_SRI_LANKA_ROOMS.md` — guest
  picks specific room(s) by name/photo, not a count. Send `roomIds` (not
  `rooms`) on `POST /api/bookings` — one entry per selected room, their
  combined `capacity` must cover `guests` (`400` otherwise, show that
  message directly), and price is derived server-side from the selected
  rooms' own rates. **Availability is whole-property, not per-room** (§1.1,
  reversed from the original per-room design once whole-villa locking
  shipped): booking any room(s) blocks every room for those dates, so a
  candidate date range is either free for the whole property or it isn't —
  `GET /api/availability/:propertyId`'s per-block `roomId` is informational
  (which room a block is "for," for admin display) and shouldn't be used to
  compute per-room availability on the guest-facing calendar.
- **`property.rooms` is empty**: unchanged, older behavior — `guests` +
  `rooms` (optional, defaults to `1`) together select the exact
  `PricingTier` row from `property.pricingTiers` (`{ guestCount, rooms,
  pricePerNight }[]`); group by `guestCount` to see whether more than one
  `rooms` option exists for that party size. `the-nest-bologna` has exactly
  one `rooms: 1` tier per guest count, so no room selector is needed there
  at all. `400` if no tier exists for the requested combination.

Either way: never compute or send a price yourself — the server always
derives `totalPrice` itself, from whichever of the two mechanisms applies
to that property.

### 16.6 Currency is per-property

`property.currency` is `"eur"` for The Nest Bologna and `"usd"` for Dona's
Villa — format guest-facing prices accordingly (`€` vs `$`), don't hardcode
one currency site-wide. `Booking.currency` in every booking response always
matches `property.currency`.

### 16.7 Dates: send plain `YYYY-MM-DD`, not full ISO timestamps

`checkIn`/`checkOut` are stored as dates only, no time component. Sending a
full ISO datetime risks the calendar date shifting by a day once converted to
UTC (e.g. a late-evening Sri Lanka timestamp rolling into the next UTC day).
Always send plain date strings, e.g. `"2026-08-01"`.

### 16.8 CORS

`CORS_ORIGIN` in the backend's `.env` must exactly match the frontend's
origin (`src/app.ts` → `cors({ origin: env.corsOrigin })`, currently only a
single origin string, no allowlist). Defaults to `http://localhost:3000` for
local dev — update it before deploying if the production frontend domain
differs.

### 16.9 Image upload

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

## 17. Error shape

```json
{ "error": "date_conflict", "message": "These dates are no longer available for this property." }
```

Validation errors (Zod) return `400` with
`{ "error": "validation_error", "message": "Request failed validation", "details": [{ "path": "body.guestEmail", "message": "Required" }, ...] }`
— `path` is dot-joined, prefixed with `body`/`query`/`params` per where the
field lives in the request.

## 18. Not yet wired (see BACKEND_PLAN.md for context)

- WhatsApp transfer confirmations (currently a manual admin action, per plan §11)
- Government ID-export endpoint for Italy/Sri Lanka compliance filing (data is captured on `Booking`, export route not yet built)
