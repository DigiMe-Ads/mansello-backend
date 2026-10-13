-- BACKEND_CHANGES_VARIANTS_CALENDAR_PAYMENTS_LK.md: product variations (§1) and
-- Payments.lk for Sri Lanka (§3). Additive only — existing products have no
-- variants, existing bookings/orders default to paymentProvider 'stripe'.

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "chargeAmount" DECIMAL(12,2),
ADD COLUMN     "chargeCurrency" TEXT,
ADD COLUMN     "fxRate" DECIMAL(12,6),
ADD COLUMN     "paymentNote" TEXT,
ADD COLUMN     "paymentProvider" TEXT NOT NULL DEFAULT 'stripe',
ADD COLUMN     "paymentsLkCheckoutId" TEXT,
ADD COLUMN     "paymentsLkPaymentId" TEXT,
ADD COLUMN     "paymentsLkRefundId" TEXT,
ADD COLUMN     "refundAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "refundStatus" TEXT,
ADD COLUMN     "refundedChargeAmount" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "StockLevel" ADD COLUMN     "variantId" TEXT,
ALTER COLUMN "productId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "chargeAmount" DECIMAL(12,2),
ADD COLUMN     "chargeCurrency" TEXT,
ADD COLUMN     "fxRate" DECIMAL(12,6),
ADD COLUMN     "paymentNote" TEXT,
ADD COLUMN     "paymentProvider" TEXT NOT NULL DEFAULT 'stripe',
ADD COLUMN     "paymentsLkCheckoutId" TEXT,
ADD COLUMN     "paymentsLkPaymentId" TEXT,
ADD COLUMN     "paymentsLkRefundId" TEXT,
ADD COLUMN     "refundAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "refundStatus" TEXT,
ADD COLUMN     "refundedChargeAmount" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "variantId" TEXT,
ADD COLUMN     "variantNameSnapshot" TEXT;

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "sku" TEXT NOT NULL,
    "priceUsd" DECIMAL(10,2) NOT NULL,
    "weightKg" DECIMAL(8,3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_sku_key" ON "ProductVariant"("sku");

-- CreateIndex
CREATE INDEX "ProductVariant_productId_idx" ON "ProductVariant"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_productId_name_key" ON "ProductVariant"("productId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_paymentsLkCheckoutId_key" ON "Booking"("paymentsLkCheckoutId");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_paymentsLkPaymentId_key" ON "Booking"("paymentsLkPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "StockLevel_variantId_key" ON "StockLevel"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_paymentsLkCheckoutId_key" ON "Order"("paymentsLkCheckoutId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_paymentsLkPaymentId_key" ON "Order"("paymentsLkPaymentId");

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A stock row belongs to exactly one of a product (no variants) or a variant.
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_exactly_one_owner"
  CHECK (("productId" IS NULL) <> ("variantId" IS NULL));

-- Same lockdown as every other table (20261006000000_security_audit): the
-- backend connects as the owner and bypasses RLS; Supabase's anon role gets
-- nothing.
ALTER TABLE "ProductVariant" ENABLE ROW LEVEL SECURITY;
