-- CreateTable
CREATE TABLE "Room" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subtitle" TEXT,
    "capacity" INTEGER NOT NULL,
    "pricePerNight" DECIMAL(10,2) NOT NULL,
    "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Room_propertyId_active_idx" ON "Room"("propertyId", "active");

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: AvailabilityBlock gets roomId
ALTER TABLE "AvailabilityBlock" ADD COLUMN     "roomId" TEXT;

-- AddForeignKey
ALTER TABLE "AvailabilityBlock" ADD CONSTRAINT "AvailabilityBlock_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "AvailabilityBlock_roomId_status_idx" ON "AvailabilityBlock"("roomId", "status");

-- bookingId is no longer unique — a room booking creates one block per
-- reserved room, all sharing the same bookingId. Drop the old unique index,
-- replace with a plain one (still queried heavily via updateMany({ where: { bookingId } })).
DROP INDEX "AvailabilityBlock_bookingId_key";
CREATE INDEX "AvailabilityBlock_bookingId_idx" ON "AvailabilityBlock"("bookingId");

-- AlterTable: Booking gets roomIds
ALTER TABLE "Booking" ADD COLUMN     "roomIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- The single exclusion constraint that used to cover every AvailabilityBlock
-- row (propertyId + overlapping daterange, regardless of room) no longer
-- expresses the right rule now that a property can have per-room blocks
-- alongside whole-property ones: Postgres has no EXCLUDE operator for
-- "NULL roomId conflicts with every roomId", so a single constraint can't
-- capture "a whole-property block conflicts with every room, and two
-- bookings of the SAME specific room conflict with each other, but two
-- bookings of DIFFERENT rooms in the same property don't."
--
-- Replaced with two narrower constraints that together cover the two
-- highest-frequency, highest-concurrency-risk cases at the database level,
-- same as before:
--   1. Two whole-property blocks (roomId IS NULL) can't overlap — this is
--      exactly the old constraint, just scoped to roomId IS NULL rows. For
--      any property with zero rooms (The Nest Bologna), every block is
--      always roomId IS NULL, so this is byte-for-byte the same guarantee
--      that property had before — zero behavior change.
--   2. Two room-specific blocks (roomId IS NOT NULL) on the SAME room can't
--      overlap — this is what actually stops two guests racing onto the
--      same physical room concurrently, which is the case that matters most
--      (public, guest-facing, high-concurrency).
--
-- The remaining case — a whole-property block landing at the same instant
-- as a room-specific one for the same property/dates — is checked at the
-- application level instead (see computeBookingPrice's per-room overlap
-- check and availability/service.ts's isRangeFree), inside the same
-- transaction as the insert. That's a narrow, low-frequency race (manual
-- whole-property blocks and Airbnb imports aren't high-concurrency,
-- guest-facing writes) — same class of accepted residual risk as the
-- turnoverBufferDays check and the Airbnb sync-lag window already documented
-- elsewhere in this codebase, not a new category of risk.
ALTER TABLE "AvailabilityBlock" DROP CONSTRAINT "availability_block_no_overlap";

ALTER TABLE "AvailabilityBlock"
  ADD CONSTRAINT availability_block_no_overlap_property_wide
  EXCLUDE USING gist (
    "propertyId" WITH =,
    daterange("startDate", "endDate", '[)') WITH &&
  )
  WHERE (status = 'active' AND "roomId" IS NULL);

ALTER TABLE "AvailabilityBlock"
  ADD CONSTRAINT availability_block_no_overlap_room
  EXCLUDE USING gist (
    "propertyId" WITH =,
    "roomId" WITH =,
    daterange("startDate", "endDate", '[)') WITH &&
  )
  WHERE (status = 'active' AND "roomId" IS NOT NULL);
