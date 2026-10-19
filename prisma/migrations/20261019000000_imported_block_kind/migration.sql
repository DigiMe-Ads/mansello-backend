-- What an imported (Airbnb / Booking.com) block actually is. Airbnb's export
-- mixes real reservations (SUMMARY "Reserved") with nights that are merely
-- closed on Airbnb (SUMMARY "Airbnb (Not available)": host blocks, the
-- listing's booking window, prep time). Both still block the dates; this only
-- lets the admin tell them apart. NULL = not an import, or a Booking.com event
-- (its export says "CLOSED - Not available" for bookings and closures alike).
-- Existing rows are re-tagged on the next sync.
-- CreateEnum
CREATE TYPE "ImportedBlockKind" AS ENUM ('reservation', 'blocked');

-- AlterTable
ALTER TABLE "AvailabilityBlock" ADD COLUMN     "importKind" "ImportedBlockKind";
