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