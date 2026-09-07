-- BACKEND_CHANGES_MARKETPLACE_PAYMENTS.md: the marketplace moves from
-- cash-on-delivery to up-front Stripe card payment, mirroring how Booking
-- already holds a stripePaymentIntentId. "cod" survives as the column
-- default only for historical rows; the application always writes "card"
-- for new orders going forward — see modules/marketplace/orders/service.ts.

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "stripePaymentIntentId" TEXT;
ALTER TABLE "Order" ALTER COLUMN "paymentMethod" SET DEFAULT 'card';
