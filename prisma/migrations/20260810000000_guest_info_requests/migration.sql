-- CreateEnum
CREATE TYPE "BookingInfoRequestStatus" AS ENUM ('pending', 'submitted', 'expired');

-- CreateTable
CREATE TABLE "GuestInfoFormTemplate" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "fields" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuestInfoFormTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingInfoRequest" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" "BookingInfoRequestStatus" NOT NULL DEFAULT 'pending',
    "fields" JSONB NOT NULL,
    "answers" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingInfoRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BookingInfoRequest_token_key" ON "BookingInfoRequest"("token");

-- CreateIndex
CREATE INDEX "BookingInfoRequest_bookingId_idx" ON "BookingInfoRequest"("bookingId");

-- AddForeignKey
ALTER TABLE "BookingInfoRequest" ADD CONSTRAINT "BookingInfoRequest_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
