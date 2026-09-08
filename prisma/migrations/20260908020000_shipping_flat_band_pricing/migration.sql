-- BACKEND_CHANGES_SHIPPING_FLAT_BAND_PRICING.md: pricePerKg was never
-- actually a per-kg rate — the client entered it as a flat band price, and
-- application code multiplied it by weight, producing a real production
-- bug (a $9.99 "3kg" band charged $29.97 on a 3kg order). Column rename
-- only — existing values are NOT transformed, they were correct flat
-- prices all along; only the (now-removed) multiplication was wrong.

-- AlterTable
ALTER TABLE "ShippingRate" RENAME COLUMN "pricePerKg" TO "price";
ALTER TABLE "ShippingRate" ALTER COLUMN "price" SET DEFAULT 0;
