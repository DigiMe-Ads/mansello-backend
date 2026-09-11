-- BACKEND_CHANGES_ADMIN_CONTENT_REQUESTS.md §1: "can't find it in the
-- catalog?" marketplace lead form.

-- CreateTable
CREATE TABLE "CustomOrderRequest" (
    "id" TEXT NOT NULL,
    "site" "Site" NOT NULL DEFAULT 'sri_lanka',
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "itemDescription" TEXT NOT NULL,
    "notes" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'new',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomOrderRequest_pkey" PRIMARY KEY ("id")
);
