-- BACKEND_CHANGES_VILLA_TRANSPORT.md §2 (revised): Property.transportEnabled
-- must default true, not false — there is no admin UI control for this
-- field, so `false` silently and permanently strands the whole feature off
-- with no way back short of a direct DB write. The real per-property "off
-- by default" gate is each TransportRate row's own `active` flag.
--
-- Backfills both existing properties to `true` as well: the earlier
-- migration (20260908010000_villa_transport) shipped with the wrong
-- default, and the client had already configured real, active
-- TransportRate rows for Dona's Villa (all 8 guest counts) that this bug
-- was silently making unchargeable.

-- AlterTable
ALTER TABLE "Property" ALTER COLUMN "transportEnabled" SET DEFAULT true;

-- Backfill
UPDATE "Property" SET "transportEnabled" = true WHERE "transportEnabled" = false;
