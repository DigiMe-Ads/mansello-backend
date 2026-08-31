-- CreateEnum
CREATE TYPE "ClickDevice" AS ENUM ('desktop', 'tablet', 'mobile');

-- CreateTable
-- BigInt identity id rather than this schema's usual String @default(uuid())
-- — deliberate for this one high-volume, public, unauthenticated-insert
-- table (cheaper to generate and index at volume than a UUID) — see
-- BACKEND_CHANGES_HEATMAP_ANALYTICS.md and the model comment in schema.prisma.
CREATE TABLE "ClickEvent" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY,
    "site" "Site",
    "path" TEXT NOT NULL,
    "xPct" REAL NOT NULL,
    "yPct" REAL NOT NULL,
    "viewportWidth" INTEGER NOT NULL,
    "device" "ClickDevice" NOT NULL,
    "sessionId" TEXT NOT NULL,
    "targetSelector" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClickEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Matches the read side's actual query shape (filter by path + device,
-- range on occurredAt) — see modules/analytics/service.ts.
CREATE INDEX "ClickEvent_path_device_occurredAt_idx" ON "ClickEvent"("path", "device", "occurredAt");
