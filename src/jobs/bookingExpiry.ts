import { expireStalePendingBookings } from "@/modules/bookings/service";

export async function runBookingExpiryJob() {
  const count = await expireStalePendingBookings();
  if (count > 0) console.log(`Expired ${count} stale pending_payment booking(s)`);
}
