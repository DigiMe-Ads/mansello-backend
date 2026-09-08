-- BACKEND_CHANGES_ICAL_MINUS_ONE_DAY.md: per-property opt-in to trim the
-- imported Airbnb block's checkout day by one. Defaults to `true` (today's
-- unchanged, padded behavior) so this migration is a no-op on its own —
-- see the Property.icalCheckoutDayBuffer schema comment for why, and do
-- not flip it to `false` for a property without first confirming that
-- property's own feed actually pads (investigated and found not to,
-- against current data, for either real property at the time this shipped).

-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "icalCheckoutDayBuffer" BOOLEAN NOT NULL DEFAULT true;
