# Mansello Backend — Planning Outline

Status: **planning only, no code yet**. This document is meant to be dropped into a new,
separate backend repo and used as the brief for building it in Claude Code.

## 1. What the frontend currently tells us

The existing Next.js app (`mansello`) is 100% static/presentational — no API calls, no
forms wired up, no cart, no auth. It renders two "sites" from one codebase:

- **`/italy/*`** — marketing + direct booking for **The Nest Bologna** (Bologna, Italy).
  Studio B&B, sleeps up to 4, tiered per-guest pricing (`room-pricing.tsx`), a
  read-only calendar + reserve button (`booking-calendar.tsx`), and an airport-transfer
  add-on flow described narratively in `booking-flow.tsx`.
- **`/sri-lanka/*`** — marketing + direct booking for **Dona's Villa** (Sri Lanka),
  same structural pattern, plus:
  - **`/sri-lanka/transport`** — fixed-price airport transfers ($29.99 each way) and a
    "Request a Quote" custom transport button (no backend).
  - **`/sri-lanka/marketplace`** — a storefront for importing genuine Italian goods
    into Sri Lanka (categories, "deal of the day", best products grid) — currently
    hardcoded mock products, no cart/checkout UI at all yet.
- Both sites share a contact form pattern (`contact-form.tsx`) with a subject dropdown
  (Room Booking / Airport Transfer / Marketplace / Other) — currently not wired to
  anything.
- No admin UI, no auth, no order/booking state anywhere in the frontend today.

This means the backend isn't just an API for existing forms — it needs to originate the
booking engine, the store, and the admin panel more or less from scratch, in a way the
frontend can later be wired into.

## 2. Scope confirmed with you

1. Two villas, each with **direct bookings** — Italy and Sri Lanka.
2. Each villa is **also listed on Airbnb** — direct-booking dates and Airbnb-booked
   dates must never collide.
3. Villa payments go through **two separate Stripe accounts** (one per country/villa).
4. A **marketplace**, Sri Lanka-facing only, selling imported goods, **cash on delivery
   only for launch** (online payment is a future add-on).
5. Marketplace needs **inventory management** + **order management**.
6. A single **admin panel** across both villas + the marketplace (bookings, orders,
   inventory, content).

## 3. Proposed architecture

A standalone Node.js service (separate repo from the frontend), exposing a REST API
consumed by: the existing public Next.js site, and a new admin panel (could be a
separate small app, e.g. `admin.mansello.com`, or a protected route tree — your call,
doesn't change the backend design).

```
mansello-backend/
  src/
    modules/
      properties/        # villa config: The Nest Bologna, Dona's Villa
      availability/       # calendar, blocks, Airbnb iCal sync
      bookings/            # direct-booking lifecycle + Stripe payment
      payments/            # Stripe client wrappers, per-account routing, webhooks
      marketplace/
        catalog/           # products, categories, stock
        orders/            # COD order lifecycle
      leads/               # contact form + transport quote requests
      admin/               # admin users, roles, dashboard aggregation
      notifications/       # email (+ optional WhatsApp) senders
    jobs/                  # scheduled iCal sync, pending-booking expiry, low-stock alerts
    db/                    # migrations, schema
```

## 4. The tricky part: villas double-listed on Airbnb

Airbnb does not give independent hosts a general-purpose real-time booking API — that
tier of integration is reserved for certified Property Management Systems / channel
managers (Hostaway, Smoobu, Guesty, Lodgify, etc.). For a self-built backend, the
realistic mechanism is **iCal two-way sync**, which is what most small hosts use even
when they also run their own booking engine. Recommend designing for this, with the
option to swap in a paid channel-manager API later without changing the core data
model.

**Design:**

- Every property has an `airbnb_ical_import_url` (the "Export Calendar" link Airbnb
  gives you for that listing) and generates its own `ical_export_token` (a unique URL
  you paste into Airbnb's "Import Calendar" field), built with `ical-generator`.
- A scheduled job (every 30–60 min, via `node-cron` or a BullMQ repeatable job) pulls
  the Airbnb ICS feed with `node-ical`, diffs it against stored blocks, and upserts rows
  into an `availability_blocks` table with `source = 'airbnb'`.
- Our own confirmed direct bookings are exposed via the export feed so Airbnb blocks
  those dates too.
- **Known residual risk:** iCal sync is not instant (Airbnb typically refreshes
  imported calendars roughly hourly), so a same-day double booking during that window
  is theoretically possible on Airbnb's side (out of our control). Mitigate with:
  a shorter poll interval on *our* side, an admin dashboard warning if a conflict is
  ever detected between an Airbnb block and a direct booking (reconcile manually,
  contact whichever guest arrived second), and clear cancellation-policy language.
- **DB-level guarantee for our own bookings:** use a Postgres **exclusion constraint**
  (`EXCLUDE USING gist`, needs the `btree_gist` extension) on
  `(property_id WITH =, daterange(check_in, check_out, '[)') WITH &&)`, scoped with a
  `WHERE status <> 'cancelled'` predicate. This makes it *impossible* — even under
  concurrent requests — for two active bookings (direct or Airbnb-imported, since both
  live in the same table) to overlap for the same property, independent of any
  application-level race condition.
- **Payment-hold flow:** when a guest starts checkout, create a booking row with
  `status = 'pending_payment'` (this already occupies the date range via the exclusion
  constraint, so nobody else can grab it mid-checkout) and an expiry timestamp (e.g. 15
  minutes). A background job cancels expired `pending_payment` rows so abandoned
  checkouts free the dates. On Stripe webhook success, flip to `confirmed`.

## 5. Stripe (two accounts)

- One Stripe **secret key + webhook signing secret pair per villa**, stored as two
  independent config entries (not Stripe Connect — these are just two normal,
  separate Stripe accounts you already own). `payments/` module picks the right
  client based on `booking.property_id`.
- Two separate webhook endpoints (`/webhooks/stripe/italy`, `/webhooks/stripe/sri-lanka`)
  so each is verified against its own signing secret.
- Client has confirmed the Sri Lanka Stripe account is already live and working, so no
  further verification needed there — just wire both accounts up as config, no special
  handling for account eligibility.

## 6. Currency

**Decision: USD everywhere** — both villas and the marketplace price, charge, and store
amounts in USD, on both the Italy and Sri Lanka sides. This deliberately avoids
EUR/LKR conversion, FX-rate drift, and split-currency reporting entirely. All Stripe
charges (both accounts) are created in USD; `properties.currency` and
`products.currency` are still explicit columns (not hardcoded), so a future move to
local-currency pricing on one side is a config change, not a schema change. The
`Rs`/`€` amounts currently in the frontend mock data are placeholders to be replaced
with USD figures once this is backend-driven.

## 7. Marketplace (Sri Lanka only, COD for now)

**Catalog / inventory:**
- `categories`, `products` (name, description, category, price in USD, images, active
  flag, SKU), `stock` (quantity on hand, low-stock threshold).
- Admin CRUD for all of the above; stock decrements on order confirmation, with a
  low-stock alert surfaced on the admin dashboard.

**Orders (COD):**
- Guest checkout (name, phone, delivery address, notes) — no customer accounts needed
  for launch.
- Order lifecycle: `pending → confirmed → packed → shipped → delivered → cancelled /
  returned`. "Confirmed" = admin has called/verified the order (standard practice for
  COD storefronts, since there's no payment capture to confirm against); stock is
  decremented at `confirmed`, not at `pending`, so browsing abandoned carts never ties
  up inventory.
- `payment_method` field on the order from day one (`cod` now), so a future Stripe/
  PayHere online-payment option is additive, not a rework.
- Order items keep a price snapshot at time of order (don't just reference live
  product price) so historical orders stay accurate if prices change later.
- **Shipping:** flat-rate, island-wide delivery fee for launch (configurable in admin,
  not per-zone) — delivery itself is handled offline by your own staff/driver, no
  courier/tracking API integration for now; admin just marks orders `shipped` /
  `delivered` manually.
- **COD abuse guard:** track order history by phone number; once a customer accumulates
  more than a configurable number of `cancelled`/`returned` orders (default: 3), flag
  their future orders in the admin queue instead of silently blocking them — keeps a
  human in the loop rather than auto-rejecting a legitimate repeat customer.

## 8. Admin panel

Single panel, role-scoped:
- **super_admin** — sees everything.
- **villa_manager** (scoped to one property) — bookings, calendar blocks, pricing for
  their villa.
- **marketplace_manager** — products, stock, orders.

Capabilities:
- Villas: calendar view per property (direct + Airbnb-imported blocks, colour-coded),
  manual date blocking (maintenance, personal use), manual booking creation (phone/
  walk-in guests), booking list with filters/search, pricing-tier editing.
- Marketplace: product CRUD with image upload, stock adjustment, order queue with
  status updates and a simple "mark delivered / mark cancelled" workflow.
- Leads: contact-form submissions and transport "Request a Quote" submissions, both as
  a simple inbox (new/read/responded).
- Dashboard: upcoming check-ins/outs, revenue per villa, low-stock items, pending
  orders count.
- Auth: email + password (bcrypt/argon2) + JWT access/refresh tokens; this is
  internal-only, so no need for social login etc.

## 9. Core data model (entities, not final schema)

- `properties` — id, name, country, currency (`usd`), timezone (IANA, e.g.
  `Europe/Rome` / `Asia/Colombo`), check_in_time, check_out_time, min_nights,
  turnover_buffer_days (cleaning gap between bookings, default 0), stripe_account_ref,
  max_guests, address
- `pricing_tiers` — property_id, guest_count, price_per_night
- `availability_blocks` — property_id, date_range, source (`direct` | `airbnb` |
  `manual`), status, external_uid (Airbnb UID for dedup on re-sync)
- `bookings` — property_id, guest name/email/phone, guest_id_document_type,
  guest_id_document_number (see compliance note below), check_in, check_out, guests,
  total_price, currency, stripe_payment_intent_id, status, expires_at (for pending
  holds), cancelled_at, refund_amount, refund_reason
- `transport_requests` — property_id (nullable if generic), type (fixed-price /
  custom-quote), date, flight_number, passengers, contact info, status
- `categories`, `products`, `stock_levels`
- `orders`, `order_items` (price snapshot)
- `contact_messages` — site (italy/sri-lanka), name, email, subject, message, status
- `admin_users` — email, password_hash, role, property_scope

**Cancellation & refund policy (default, adjustable per property):** free cancellation
up to 7 days before check-in (full refund), 50% refund 3–7 days before, no refund
inside 72 hours. Cancelling triggers a Stripe refund via the correct villa's account
for the computed amount; the admin can always override the amount manually for
goodwill exceptions. This only governs *direct* bookings — Airbnb-booked guests are
covered by Airbnb's own cancellation policy, not this one.

**Guest ID compliance:** Italy legally requires reporting guest ID/passport details to
police within 24h of check-in (Alloggiati Web); Sri Lanka has its own tourist
registration norms. Rather than building a direct government-portal integration (Italy's
Portale Alloggiati API access is restrictive and not worth it at this scale), the
booking flow captures ID document type + number as a required field before check-in,
and the admin panel offers a per-property, per-date-range export so whoever handles
the actual filing (you, or your host) has the data on hand. No automated submission.

## 10. Suggested tech stack (Node.js)

- **Framework:** Fastify or Express are both fine at this scope; NestJS is worth
  considering only if you want enforced module boundaries across this many domains —
  otherwise a well-organized Express app is simpler to keep moving fast in Claude Code.
- **DB:** PostgreSQL (needed for the exclusion-constraint trick above) + Prisma as ORM
  (the exclusion constraint itself is added via a raw SQL migration, since Prisma's
  schema language can't express it directly).
- **Queue/jobs:** BullMQ + Redis for the Airbnb sync poll, pending-booking expiry, and
  low-stock/email notifications — or just `node-cron` if you'd rather avoid running
  Redis for an MVP.
- **Validation:** Zod on all inputs.
- **Payments:** `stripe` SDK, two client instances.
- **Calendar sync:** `node-ical` (read Airbnb feed), `ical-generator` (produce our feed).
- **Email:** Resend or SMTP via Nodemailer for booking confirmations / order
  confirmations; the frontend copy also promises WhatsApp confirmations for transfers —
  flag whether that's a manual admin action or something you want automated (e.g. via
  the WhatsApp Business API), since that's a materially different integration.
- **File storage:** S3-compatible bucket (Cloudflare R2 is cheap) for product images
  uploaded via the admin panel.
- **Auth:** JWT access + refresh tokens, bcrypt/argon2 password hashing.

## 11. Decisions locked in this round

- **Stripe:** both accounts already exist and work — no eligibility question left, just
  wire them up as two config entries (§5).
- **Currency:** USD everywhere, both villas and marketplace, no conversion (§6).
- **Cancellation/refunds, guest-ID compliance, min-stay/turnover buffer, timezones,
  shipping, and COD-abuse handling** now have concrete defaults baked into §7 and §9
  above, rather than sitting as open questions — all are config values on `properties`
  or simple thresholds, so tightening or loosening any of them later is a config change,
  not a schema change.
- **Manual/offline bookings:** admin can create a booking directly (no Stripe checkout),
  marked `paid_offline`; it still goes through the same `bookings` table and exclusion
  constraint as everything else, so it can never silently double-book a date.
- **Testimonials / "Latest News":** left **out of backend scope** for launch — both are
  static placeholder marketing content in the frontend today (the news section's own
  copy literally says "section retained as designed"), with no dynamic requirement yet.
  Add a lightweight CMS table later only if you actually start publishing regularly.
- **Airbnb/direct sync-lag conflicts:** accepted as a rare residual risk of iCal sync
  (§4) rather than something to engineer around further — the admin dashboard should
  surface any detected overlap so it's handled manually (reschedule/refund/apologize)
  the few times it might ever happen.
- **WhatsApp confirmations** (mentioned in the transfer-booking copy): still open —
  defaulting to a manual admin action (copy-paste from the admin panel) rather than an
  automated WhatsApp Business API integration, since that's a separate integration
  effort. Revisit only if manual copy-pasting becomes a real bottleneck.

## 12. Suggested build order

1. DB schema + exclusion constraint + properties/pricing (no payments yet).
2. Direct booking flow with pending-hold + Stripe per-account payment + webhook
   confirmation.
3. Airbnb iCal import/export + sync job.
4. Admin panel: auth, villa calendar view, manual booking/blocking.
5. Marketplace catalog + inventory admin.
6. Marketplace COD checkout + order management admin.
7. Contact + transport quote request inboxes.
8. Notifications (email at minimum) wired into booking/order status changes.
