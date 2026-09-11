-- BACKEND_CHANGES_VILLA_TRANSPORT.md §2 (this revision): now that the villa
-- admin's Transport tab has a real master on/off switch
-- (PATCH /api/properties/:propertyId { transportEnabled }), the earlier
-- default:true (20260909010000_transport_enabled_default_true) is no
-- longer needed to avoid stranding the feature off - a client can just
-- flip it themselves. Reverting to the doc's originally-intended default:
-- an untouched property should not surface the add-on.
--
-- Only The Nest Bologna is reset to false here - it has zero TransportRate
-- rows configured (never "touched" for this feature) and its true value
-- was purely a side effect of the earlier stranding-bug fix backfilling
-- every property indiscriminately. Dona's Villa is deliberately left
-- alone: it has real, active, client-configured TransportRate rows and is
-- already correctly charging for them - flipping it off here would be a
-- real regression, not a fix.

-- AlterTable
ALTER TABLE "Property" ALTER COLUMN "transportEnabled" SET DEFAULT false;

-- Backfill (Bologna only - see comment above)
UPDATE "Property" SET "transportEnabled" = false WHERE "slug" = 'the-nest-bologna';
