-- BACKEND_CHANGES_PRODUCT_DETAILS_SUBCATEGORIES_ICAL.md §1: every iCal import
-- used to be stored as source 'airbnb' whichever feed it came from. Re-tag the
-- Booking.com ones (their UID still carries the origin). New syncs set
-- 'booking_com' themselves — see detectSource in jobs/airbnbSync.ts. Covers
-- cancelled rows too, so history is labelled consistently.
UPDATE "AvailabilityBlock"
SET "source" = 'booking_com'
WHERE "source" = 'airbnb' AND "externalUid" ILIKE '%@booking.com';
