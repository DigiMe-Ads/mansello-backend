-- BACKEND_CHANGES_VILLA_TRANSPORT.md: priced airport-transfer add-on.

-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "transportEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "transportPrice" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "TransportRate" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "guestCount" INTEGER NOT NULL,
    "price" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransportRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TransportRate_propertyId_guestCount_key" ON "TransportRate"("propertyId", "guestCount");

-- AddForeignKey
ALTER TABLE "TransportRate" ADD CONSTRAINT "TransportRate_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
