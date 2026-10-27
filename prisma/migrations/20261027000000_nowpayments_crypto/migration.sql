-- NOWPayments (crypto) on bookings and marketplace orders — see
-- src/modules/payments/nowPayments.ts. paymentProvider gains the value
-- "nowpayments" (plain text column, no enum change needed).

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "cryptoPayAmount" TEXT,
ADD COLUMN     "cryptoPayCurrency" TEXT,
ADD COLUMN     "nowPaymentsInvoiceId" TEXT,
ADD COLUMN     "nowPaymentsPaymentId" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "cryptoPayAmount" TEXT,
ADD COLUMN     "cryptoPayCurrency" TEXT,
ADD COLUMN     "nowPaymentsInvoiceId" TEXT,
ADD COLUMN     "nowPaymentsPaymentId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Booking_nowPaymentsInvoiceId_key" ON "Booking"("nowPaymentsInvoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_nowPaymentsInvoiceId_key" ON "Order"("nowPaymentsInvoiceId");
