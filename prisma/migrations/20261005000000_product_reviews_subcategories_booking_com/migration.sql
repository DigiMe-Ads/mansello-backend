-- BACKEND_CHANGES_PRODUCT_DETAILS_SUBCATEGORIES_ICAL.md

-- §1: tag Booking.com iCal imports separately from Airbnb ones.
-- AlterEnum
ALTER TYPE "AvailabilitySource" ADD VALUE 'booking_com';

-- §1: per-import-URL sync outcome, shown under the admin textarea.
-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "icalImportStatus" JSONB NOT NULL DEFAULT '[]';

-- §4: subcategories (one level). Nullable, so every existing category stays
-- top-level.
-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "parentId" TEXT;

-- CreateIndex
CREATE INDEX "Category_parentId_idx" ON "Category"("parentId");

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- §5: product reviews.
-- CreateTable
CREATE TABLE "ProductReview" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "authorName" VARCHAR(80) NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT NOT NULL,
    "ipHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductReview_productId_createdAt_idx" ON "ProductReview"("productId", "createdAt");

-- AddForeignKey
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
