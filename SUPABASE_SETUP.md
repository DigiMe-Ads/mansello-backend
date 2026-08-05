# Using Supabase as the Postgres backend

This backend talks to Postgres directly via Prisma (not through Supabase's
PostgREST/Data API), so Supabase here is really just "managed Postgres +
connection pooling + storage if you want it later." Row Level Security is
**not** required for this setup, because only this Node service ever touches
the database — RLS only matters if you also let the frontend talk to Supabase
directly with the anon/publishable key, which this architecture doesn't do.

> **What changed vs. the old version of this doc:** connection strings moved
> out of Project Settings into a **Connect** button at the top of the
> dashboard; the poolers got renamed (Shared/Supavisor vs. Dedicated/PgBouncer);
> and the transaction pooler is **no longer the right default** for a
> persistent Node server — see §2.

---

## 1. Create the project

1. [supabase.com/dashboard](https://supabase.com/dashboard) → **New project**
2. Pick an org, name it (`mansello`), and set a **database password** — save it
   now, it's only shown once. (If you lose it: Project Settings → Database →
   *Reset database password*.)
3. **Region:** pick the one closest to wherever the *Node API* will be hosted,
   not close to Italy or Sri Lanka. Guests hit your API; only your API hits
   Postgres.
4. Wait ~2 minutes for provisioning.

**Optional but recommended:** since you're not using PostgREST at all, turn the
Data API off — Project Settings → **API** → Data API → disable. One less public
surface, and it makes the "no RLS needed" decision explicit rather than
accidental.

---

## 2. Get the two connection strings

The old path (Project Settings → Database → Connection string) doesn't exist
anymore. Now:

> **Connect** button at the top of the dashboard → **ORMs** tab → **Prisma**
> (or the **Direct connection / Session pooler / Transaction pooler** tabs
> under **App Frameworks**).

You'll see up to four options. Which you want depends on how the API is
deployed:

| Option | Host / port | Use it for |
| --- | --- | --- |
| **Direct connection** | `db.<ref>.supabase.co:5432` | Migrations, `pg_dump`, long-lived servers — **IPv6 only** unless you buy the IPv4 add-on |
| **Session pooler** (Shared / Supavisor) | `aws-<region>.pooler.supabase.com:5432` | Persistent Node servers on IPv4-only networks. IPv4 on every plan |
| **Transaction pooler** (Shared / Supavisor) | `aws-<region>.pooler.supabase.com:6543` | Serverless / edge only |
| **Dedicated pooler** (PgBouncer) | `db.<ref>.supabase.co:6543` | Paid plans, high traffic. Transaction mode only |

### What to actually put in `.env`

This backend is a **long-running Express process**, not serverless. So:

```bash
# Runtime — session pooler, port 5432
DATABASE_URL="postgres://postgres.<PROJECT-REF>:<PASSWORD>@aws-<REGION>.pooler.supabase.com:5432/postgres"

# Prisma Migrate (DDL) — same string is fine
DIRECT_URL="postgres://postgres.<PROJECT-REF>:<PASSWORD>@aws-<REGION>.pooler.supabase.com:5432/postgres"
```

Notes on this, because it's the part people get wrong:

- **The session pooler is the safe default.** It's IPv4, works from any laptop
  or host, and supports prepared statements and DDL — so it's fine for both
  runtime *and* migrations.
- **The direct connection is IPv6-only** on the free tier. If your ISP or your
  host is IPv4-only (common in Sri Lanka, and on some VPS providers), it will
  just hang or throw `ENETUNREACH` and you'll waste an hour on it. If you *do*
  have working IPv6, use the direct string for `DIRECT_URL` — slightly lower
  latency for migrations.
- **Don't use the transaction pooler (6543) for this app.** It doesn't support
  prepared statements, which Prisma uses by default; you'd have to append
  `?pgbouncer=true` and you'd still lose session-level features. Only switch to
  it if you later move the API onto Vercel functions or similar.
- Note the username format for pooler strings: `postgres.<PROJECT-REF>`, not
  plain `postgres`. Copy it from the dashboard rather than hand-typing.
- URL-encode your password if it contains `@ : / ? # [ ] %`.

<details>
<summary>Optional: give Prisma its own DB role instead of using <code>postgres</code></summary>

Supabase now recommends this — it makes Prisma's queries distinguishable in the
Query Performance dashboard and Log Explorer. Run in the SQL Editor:

```sql
create user "prisma" with password '<generate-a-strong-one>' bypassrls createdb;
grant "prisma" to "postgres";

grant usage, create on schema public to prisma;
grant all on all tables in schema public to prisma;
grant all on all routines in schema public to prisma;
grant all on all sequences in schema public to prisma;

alter default privileges for role postgres in schema public grant all on tables to prisma;
alter default privileges for role postgres in schema public grant all on routines to prisma;
alter default privileges for role postgres in schema public grant all on sequences to prisma;
```

Then swap `postgres.<PROJECT-REF>` → `prisma.<PROJECT-REF>` and use the new
password in both connection strings.
</details>

---

## 3. Run the Prisma migration

```bash
npm run prisma:migrate -- --name init
```

This creates every table in `prisma/schema.prisma` (properties, pricing_tiers,
availability_blocks, bookings, transport_requests, categories, products,
stock_levels, orders, order_items, contact_messages, admin_users).

> **If you're on Prisma 7:** `url` and `directUrl` inside the `datasource`
> block are deprecated. Connection config moves to `prisma.config.ts`:
>
> ```ts
> import "dotenv/config";
> import { defineConfig, env } from "prisma/config";
>
> export default defineConfig({
>   schema: "prisma/schema.prisma",
>   migrations: { path: "prisma/migrations" },
>   datasource: { url: env("DIRECT_URL") },   // used by Migrate
> });
> ```
>
> The runtime connection then comes from the driver adapter
> (`new PrismaPg({ connectionString: process.env.DATABASE_URL })`). If you're
> still on Prisma 6.x, ignore this box — the `.env` setup above is all you need.

---

## 4. Add the exclusion constraint (the one thing Prisma can't express)

Prisma's schema language has no way to declare a Postgres `EXCLUDE USING gist`
constraint, so it goes in as a follow-up raw-SQL migration. Keep it in
migration history rather than pasting it ad hoc into the SQL Editor — otherwise
a fresh environment won't have it.

```bash
npx prisma migrate dev --create-only --name availability_exclusion_constraint
```

Open the generated empty file at
`prisma/migrations/<timestamp>_availability_exclusion_constraint/migration.sql`
and paste in:

```sql
-- Needed for GiST indexes over a plain equality column (propertyId) mixed
-- with a range type (daterange) in the same exclusion constraint.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Guarantees, at the database level, that no two ACTIVE rows in
-- AvailabilityBlock can ever overlap for the same property — direct
-- bookings, Airbnb-imported blocks, and manual blocks all live in this one
-- table, so this one constraint covers all three sources at once, even
-- under concurrent requests.
ALTER TABLE "AvailabilityBlock"
  ADD CONSTRAINT availability_block_no_overlap
  EXCLUDE USING gist (
    "propertyId" WITH =,
    daterange("startDate", "endDate", '[)') WITH &&
  )
  WHERE (status = 'active');
```

Then apply it:

```bash
npx prisma migrate dev
```

> Do **not** enable `btree_gist` via the dashboard toggle (Database →
> Extensions). That installs it into the `extensions` schema, which can leave
> the gist operator classes off your search path when the `ALTER TABLE` runs.
> The `CREATE EXTENSION` line inside the migration installs it into `public`,
> where it just works — and it travels with the repo.

For deploys rather than local dev: `npm run prisma:deploy`
(`prisma migrate deploy`) applies pending migrations without prompting or
generating new ones. Safe for CI/production.

---

## 5. Seed the two properties

Left sidebar → **SQL Editor** → new query:

```sql
INSERT INTO "Property"
  (id, slug, name, country, currency, timezone, "checkInTime", "checkOutTime",
   "minNights", "turnoverBufferDays", "maxGuests", address, "stripeAccountRef",
   "icalExportToken")
VALUES
  (gen_random_uuid(), 'the-nest-bologna', 'The Nest Bologna', 'Italy', 'usd',
   'Europe/Rome', '15:00', '11:00', 1, 0, 4, 'Bologna, Italy', 'italy',
   gen_random_uuid()),
  (gen_random_uuid(), 'donas-villa', 'Dona''s Villa', 'Sri Lanka', 'usd',
   'Asia/Colombo', '14:00', '11:00', 1, 0, 8, 'Sri Lanka', 'sri_lanka',
   gen_random_uuid());
```

`id` and `icalExportToken` are generated by Prisma **client-side**, not by a DB
column default — so a raw INSERT that bypasses Prisma has to supply them
itself. `gen_random_uuid()` does that. It needs `pgcrypto`, which Supabase
enables by default; if it's somehow missing, run
`CREATE EXTENSION IF NOT EXISTS pgcrypto;` first.

You can verify in the **Table Editor** (left sidebar) — no need to spin up
Prisma Studio just for this.

---

## 6. Create the first admin user

The password needs bcrypt hashing, so this has to go through the app rather
than SQL.

```bash
# terminal 1
npm run dev

# terminal 2
curl -X POST http://localhost:4000/api/admin/users \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@mansello.com","password":"Mansello@123","role":"super_admin"}'
```

That route is normally behind `requireRole("super_admin")`. For the very first
account, temporarily comment out the `requireAuth, requireRole(...)` middleware
on `POST /api/admin/users` in
[`src/modules/admin/routes.ts`](./src/modules/admin/routes.ts), create the
account, then **put the middleware back before you deploy**.

This is the standard first-admin bootstrapping problem — the only alternatives
are a public signup route (ruled out by the plan) or hand-hashing a bcrypt
string, which isn't worth it for one account.

---

## 7. Verify

```bash
curl http://localhost:4000/health
curl http://localhost:4000/api/properties
```

Both properties should come back. Then confirm the constraint is actually live
by trying to double-book — insert two overlapping active `AvailabilityBlock`
rows for the same property in the SQL Editor. The second one should fail with
`conflicting key value violates exclusion constraint`. If it doesn't, §4 didn't
apply.

---

## 8. (Optional) Supabase Storage instead of Cloudflare R2

`BACKEND_PLAN.md` §10 suggests Cloudflare R2 for product images. Since you're
already on Supabase, its built-in Storage is S3-compatible and saves you a
second provider. Functionally equivalent either way — preference call, not a
correctness one.

1. Left sidebar → **Storage** → **New bucket** → name it `product-images`,
   mark it public.
2. **Storage** → **S3 Configuration** → generate an access key pair. The secret
   is shown once.
3. Copy the endpoint (`https://<project-ref>.storage.supabase.co/storage/v1/s3`)
   and region from the same page, and drop them into the `S3_*` env vars.

These S3 keys are full-access and bypass RLS — server-side only, never ship
them to the frontend.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `ENETUNREACH` / connection hangs | You used the direct connection string on an IPv4-only network. Switch to the session pooler |
| `FATAL: Tenant or user not found` | Pooler username needs the project ref: `postgres.<PROJECT-REF>` |
| `password authentication failed` | Password has special characters that need URL-encoding, or you reset it and didn't update `.env` |
| `prepared statement "s0" already exists` | You're on the transaction pooler (6543). Move to 5432, or append `?pgbouncer=true` |
| `operator class "gist" does not exist for type text` | `btree_gist` didn't install, or installed into the `extensions` schema. See §4 |
| Migration works locally, fails in CI | CI is running `migrate dev` instead of `migrate deploy`, or `DIRECT_URL` isn't set in the CI environment |