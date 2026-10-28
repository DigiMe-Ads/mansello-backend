-- Editable guest guide per site (contact page + /{site}/guide).

-- CreateTable
CREATE TABLE "Guide" (
    "site" "Site" NOT NULL,
    "content" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "Guide_pkey" PRIMARY KEY ("site")
);
