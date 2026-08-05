# mansello-backend

Node.js/Express/TypeScript API for Mansello — direct bookings for The Nest
Bologna (Italy) and Dona's Villa (Sri Lanka), plus the Sri Lanka-facing
marketplace and a shared admin panel backend.

See [`BACKEND_PLAN.md`](./BACKEND_PLAN.md) for the full design rationale and
[`API_DOCUMENTATION.md`](./API_DOCUMENTATION.md) for the endpoint reference.

## Stack

- Express + TypeScript
- PostgreSQL via Supabase + Prisma (plus one raw-SQL migration for the
  date-overlap exclusion constraint — see `SUPABASE_SETUP.md`)
- Zod for input validation
- JWT (access + refresh) + bcrypt for admin auth
- Stripe (two separate accounts/clients — Italy & Sri Lanka)
- `node-ical` / `ical-generator` for Airbnb two-way calendar sync
- `node-cron` for scheduled jobs (Airbnb sync, booking-hold expiry, low-stock alerts)
- Resend for transactional email

## Getting started

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL etc. — see SUPABASE_SETUP.md
npm run prisma:generate
npm run prisma:migrate
npm run dev
```

Server starts on `http://localhost:4000` (`/health` for a liveness check).

## Scripts

- `npm run dev` — watch mode (tsx)
- `npm run build` / `npm start` — production build + run
- `npm run prisma:migrate` — create/apply a dev migration
- `npm run prisma:studio` — browse the DB
- `npm run typecheck` — `tsc --noEmit`

## Project layout

```
src/
  modules/
    properties/       villa config
    availability/      calendar blocks + iCal export feed
    bookings/           booking lifecycle (hold → confirm/cancel)
    payments/           Stripe clients (2 accounts) + webhooks
    marketplace/
      catalog/          products, categories, stock
      orders/            COD order lifecycle
    leads/               contact form + transport quote inboxes
    admin/               admin auth + dashboard
    notifications/       email senders
  jobs/                  node-cron: airbnb sync, booking expiry, low-stock alert
  db/, middleware/, utils/, config/
prisma/schema.prisma
```
