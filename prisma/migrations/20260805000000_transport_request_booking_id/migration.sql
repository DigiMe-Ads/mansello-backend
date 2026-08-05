-- AlterTable
ALTER TABLE "TransportRequest" ADD COLUMN     "bookingId" TEXT;

-- AddForeignKey
ALTER TABLE "TransportRequest" ADD CONSTRAINT "TransportRequest_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;
