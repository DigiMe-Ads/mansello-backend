-- Marketplace: product/variation offers, variation images, delivery
-- estimate, and deleting products that have order history.

-- Delivery estimate ("Get it within X-Y days").
ALTER TABLE "Product" ADD COLUMN "deliveryEstimateEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "deliveryMinDays" INTEGER,
ADD COLUMN "deliveryMaxDays" INTEGER;

-- Images per variation.
ALTER TABLE "ProductVariant" ADD COLUMN "images" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Order lines keep their snapshots when the product/variation is deleted.
ALTER TABLE "OrderItem" ADD COLUMN "skuSnapshot" TEXT,
ADD COLUMN "listPriceSnapshot" DECIMAL(10,2),
ADD COLUMN "discountPercent" INTEGER;
ALTER TABLE "OrderItem" ALTER COLUMN "productId" DROP NOT NULL;
ALTER TABLE "OrderItem" DROP CONSTRAINT "OrderItem_productId_fkey";
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrderItem" DROP CONSTRAINT "OrderItem_variantId_fkey";
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill the SKU snapshot for existing lines while the products still exist.
UPDATE "OrderItem" oi SET "skuSnapshot" = p."sku"
FROM "Product" p
WHERE oi."productId" = p."id" AND oi."variantId" IS NULL;
UPDATE "OrderItem" oi SET "skuSnapshot" = v."sku"
FROM "ProductVariant" v
WHERE oi."variantId" = v."id";

-- Offers.
CREATE TABLE "ProductOffer" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "title" VARCHAR(80),
    "discountPercent" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductOffer_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProductOffer_productId_idx" ON "ProductOffer"("productId");
CREATE INDEX "ProductOffer_variantId_idx" ON "ProductOffer"("variantId");
ALTER TABLE "ProductOffer" ADD CONSTRAINT "ProductOffer_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductOffer" ADD CONSTRAINT "ProductOffer_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
