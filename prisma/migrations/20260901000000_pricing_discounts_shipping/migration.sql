-- CreateTable
CREATE TABLE "RateOverride" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "roomId" TEXT,
    "guestCount" INTEGER,
    "rooms" INTEGER,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "pricePerNight" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateOverride_propertyId_startDate_endDate_idx" ON "RateOverride"("propertyId", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "RateOverride_roomId_idx" ON "RateOverride"("roomId");

-- AddForeignKey
ALTER TABLE "RateOverride" ADD CONSTRAINT "RateOverride_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateOverride" ADD CONSTRAINT "RateOverride_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: Offer date scoping
ALTER TABLE "Offer" ADD COLUMN     "startDate" DATE,
ADD COLUMN     "endDate" DATE;

-- AlterTable: Product weight
ALTER TABLE "Product" ADD COLUMN     "weightKg" DECIMAL(10,3);

-- CreateTable
CREATE TABLE "ShippingRate" (
    "id" TEXT NOT NULL,
    "fromKg" INTEGER NOT NULL,
    "toKg" INTEGER NOT NULL,
    "pricePerKg" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShippingRate_pkey" PRIMARY KEY ("id")
);

-- AlterTable: Category featured section fields
ALTER TABLE "Category" ADD COLUMN     "description" TEXT,
ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "featured" BOOLEAN NOT NULL DEFAULT false;

-- Whole-villa locking (BACKEND_CHANGES_PRICING_DISCOUNTS_SHIPPING.md §3) —
-- supersedes the independent-per-room-availability design from
-- 20260815000000_sri_lanka_rooms. Only one party occupies a room-enabled
-- property at a time now, so a block on ANY room must make the WHOLE
-- property unavailable, not just that room — the opposite of what the
-- previous two constraints (one same-room-only, one whole-property-only)
-- were built to allow.
--
-- The new rule needed at the DB level: two ACTIVE blocks for the same
-- property, overlapping dates, conflict — UNLESS they belong to the same
-- booking (a room-booking creates several per-room blocks that share one
-- bookingId and, by construction, the same date range; those must NOT
-- conflict with each other). Split by bookingId instead of roomId:
--
--   1. Both rows have bookingId (a real direct/offline booking): use
--      "bookingId WITH <>" so two rows from the SAME booking (same
--      bookingId) are exempt, but two rows from DIFFERENT bookings still
--      conflict. This is safe specifically because the WHERE clause
--      guarantees bookingId IS NOT NULL on both sides — "<>" is only
--      reliable here because there's no NULL to make it ambiguous.
--   2. Neither row has a bookingId (manual blocks, Airbnb imports): plain
--      propertyId + daterange overlap, same as the original pre-rooms
--      constraint, just scoped to bookingId IS NULL rows.
--
-- The one case neither constraint can express — a booking's block(s)
-- overlapping an existing bookingId-IS-NULL block (manual/Airbnb) — is
-- checked at the application level instead, inside the same transaction as
-- the write (see createBookingAvailabilityBlocks in
-- modules/bookings/service.ts, and isRangeFree in
-- modules/availability/service.ts). Same accepted-residual-risk class as
-- documented elsewhere in this codebase (turnoverBufferDays, Airbnb
-- sync-lag) — whole-property manual/Airbnb writes are infrequent
-- admin/import actions, not high-concurrency guest-facing ones.
ALTER TABLE "AvailabilityBlock" DROP CONSTRAINT "availability_block_no_overlap_property_wide";
ALTER TABLE "AvailabilityBlock" DROP CONSTRAINT "availability_block_no_overlap_room";

ALTER TABLE "AvailabilityBlock"
  ADD CONSTRAINT availability_block_no_overlap_by_booking
  EXCLUDE USING gist (
    "propertyId" WITH =,
    "bookingId" WITH <>,
    daterange("startDate", "endDate", '[)') WITH &&
  )
  WHERE (status = 'active' AND "bookingId" IS NOT NULL);

ALTER TABLE "AvailabilityBlock"
  ADD CONSTRAINT availability_block_no_overlap_no_booking
  EXCLUDE USING gist (
    "propertyId" WITH =,
    daterange("startDate", "endDate", '[)') WITH &&
  )
  WHERE (status = 'active' AND "bookingId" IS NULL);
