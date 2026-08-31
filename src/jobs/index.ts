import cron from "node-cron";
import { env } from "@/config/env";
import { syncAirbnbCalendars } from "./airbnbSync";
import { runBookingExpiryJob } from "./bookingExpiry";
import { runLowStockAlertJob } from "./lowStockAlert";
import { runClickEventRetentionJob } from "./clickEventRetention";

export function startJobs() {
  // Airbnb typically refreshes imported calendars roughly hourly on their
  // side; polling every 30 min on ours keeps the residual sync-lag window
  // as small as practical (BACKEND_PLAN.md §4).
  cron.schedule(env.airbnbSyncCron, () => {
    syncAirbnbCalendars().catch((err) => console.error("Airbnb sync job failed:", err));
  });

  // Frees dates held by abandoned checkouts once the pending_payment hold expires.
  cron.schedule("* * * * *", () => {
    runBookingExpiryJob().catch((err) => console.error("Booking expiry job failed:", err));
  });

  // Once a day — surfaces low-stock products to whichever inbox the admin configures.
  cron.schedule("0 8 * * *", () => {
    const adminEmail = process.env.LOW_STOCK_ALERT_EMAIL;
    if (!adminEmail) return;
    runLowStockAlertJob(adminEmail).catch((err) => console.error("Low-stock alert job failed:", err));
  });

  // Once a day — click_events is high-volume and only ever read in
  // aggregate; nothing on the frontend assumes rows live past the 90-day
  // range it offers, so 180 gives headroom without keeping data forever.
  cron.schedule("0 4 * * *", () => {
    runClickEventRetentionJob().catch((err) => console.error("Click-event retention job failed:", err));
  });

  console.log(
    "Scheduled jobs started (airbnb sync, booking expiry, low-stock alert, click-event retention)"
  );
}
