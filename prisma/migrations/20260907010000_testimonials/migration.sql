-- BACKEND_CHANGES_TESTIMONIALS.md: admin-manageable "Our Client Says!"
-- reviews, scoped to a Site (not an individual Property).

-- CreateTable
CREATE TABLE "Testimonial" (
    "id" TEXT NOT NULL,
    "site" "Site" NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Testimonial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Testimonial_site_active_sortOrder_idx" ON "Testimonial"("site", "active", "sortOrder");
