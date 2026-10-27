-- Country reach on the admin heatmap: ClickEvent.country, derived from the
-- visitor's device timezone at ingest (no IP address involved).

-- AlterTable
ALTER TABLE "ClickEvent" ADD COLUMN     "country" VARCHAR(2);

-- CreateIndex
CREATE INDEX "ClickEvent_occurredAt_country_idx" ON "ClickEvent"("occurredAt", "country");
