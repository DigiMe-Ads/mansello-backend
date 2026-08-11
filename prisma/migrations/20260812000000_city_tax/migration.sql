-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "cityTaxEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cityTaxMaxNights" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "cityTaxExemptAgeUnder" INTEGER NOT NULL DEFAULT 14,
ADD COLUMN     "cityTaxBands" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
-- "accommodationPrice" is added nullable, backfilled below, then made
-- required — a plain NOT NULL ADD COLUMN would have no value to use for
-- existing rows. "cityTax" and "childrenUnder14" can default straight to
-- their steady-state values since no existing booking ever had tax applied.
ALTER TABLE "Booking" ADD COLUMN     "accommodationPrice" DECIMAL(10,2),
ADD COLUMN     "cityTax" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "childrenUnder14" INTEGER NOT NULL DEFAULT 0;

-- Backfill existing rows: historically nothing had tax applied, so the old
-- "totalPrice" was always pure accommodation cost.
UPDATE "Booking" SET "accommodationPrice" = "totalPrice" WHERE "accommodationPrice" IS NULL;

ALTER TABLE "Booking" ALTER COLUMN "accommodationPrice" SET NOT NULL;
