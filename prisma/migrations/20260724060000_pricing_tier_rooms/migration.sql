-- DropIndex
DROP INDEX "PricingTier_propertyId_guestCount_key";

-- AlterTable
ALTER TABLE "PricingTier" ADD COLUMN     "rooms" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE UNIQUE INDEX "PricingTier_propertyId_guestCount_rooms_key" ON "PricingTier"("propertyId", "guestCount", "rooms");
