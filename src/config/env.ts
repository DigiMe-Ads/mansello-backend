import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  // Hardcoded rather than read from CORS_ORIGIN — a bad/missing env var on
  // Railway silently broke this in production once already, so the known
  // set of real sites is guaranteed correct regardless of dashboard config.
  // CORS_ORIGIN in .env.example is now purely informational/unused; update
  // this array (and redeploy) to actually change allowed origins.
  corsOrigin: [
    "http://localhost:3000",
    "https://mansello.vercel.app",
    "https://mansello.com",
    "https://www.mansello.com",
  ],
  // Used to build guest-facing links we email out (e.g. the booking-info
  // form) — same origin the frontend is served from, so no reason for this
  // to differ from CORS_ORIGIN in practice, but kept as its own var since
  // conflating "who's allowed to call us" with "where guests land" is fragile.
  frontendUrl: process.env.FRONTEND_URL ?? "http://localhost:3000",

  databaseUrl: required("DATABASE_URL"),

  jwtAccessSecret: required("JWT_ACCESS_SECRET"),
  jwtRefreshSecret: required("JWT_REFRESH_SECRET"),
  jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? "15m",
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? "30d",

  stripe: {
    italy: {
      secretKey: process.env.STRIPE_ITALY_SECRET_KEY ?? "",
      webhookSecret: process.env.STRIPE_ITALY_WEBHOOK_SECRET ?? "",
    },
    sriLanka: {
      secretKey: process.env.STRIPE_SRILANKA_SECRET_KEY ?? "",
      webhookSecret: process.env.STRIPE_SRILANKA_WEBHOOK_SECRET ?? "",
    },
  },

  // Resend (HTTPS API, not SMTP — see notifications/email.ts for why).
  // `from` must be on a domain verified in Resend's dashboard (DKIM/SPF/
  // DMARC DNS records) — mansello.com is verified, so this can't be a raw
  // @gmail.com address no matter what EMAIL_FROM is set to.
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  emailFrom: process.env.EMAIL_FROM ?? "Mansello <bookings@mansello.com>",
  // Optional — where replies to guest-facing emails actually land, since
  // EMAIL_FROM is a send-only domain address, not a real inbox.
  emailReplyTo: process.env.EMAIL_REPLY_TO ?? "",

  s3: {
    endpoint: process.env.S3_ENDPOINT ?? "",
    // "auto" works for Cloudflare R2; Supabase Storage's S3-compatible
    // endpoint needs the project's real region (SigV4 signs with this value,
    // so a wrong region fails the request, not just the returned URL).
    region: process.env.S3_REGION ?? "auto",
    bucket: process.env.S3_BUCKET ?? "",
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
    publicUrl: process.env.S3_PUBLIC_URL ?? "",
    // Guest-submitted documents (passport scans) — same endpoint/credentials,
    // but a PRIVATE bucket served only via short-lived signed URLs. Must not
    // be the public image bucket above.
    privateBucket: process.env.S3_PRIVATE_BUCKET ?? "mansello-private",
  },

  // Payments.lk (Sri Lanka card payments) — see
  // BACKEND_CHANGES_VARIANTS_CALENDAR_PAYMENTS_LK.md §3. The live key wins
  // when present, so going live is just adding PAYMENTS_LK_SECRET_KEY.
  // Never log these.
  paymentsLk: {
    secretKey: process.env.PAYMENTS_LK_SECRET_KEY || process.env.PAYMENTS_LK_SANDBOX || "",
    webhookSecret: process.env.PAYMENTS_LK_WEBHOOK_SECRET ?? "",
    // Optional fixed USD→LKR rate, e.g. if the rate source is down. Normally
    // the daily rate is fetched automatically.
    usdLkrRateOverride: Number(process.env.USD_LKR_RATE) || null,
  },
  // Cutover switch for Dona's Villa bookings and marketplace orders. Italy is
  // always Stripe. Each booking/order records its own provider, so flipping
  // this never changes how an existing payment is refunded.
  sriLankaPaymentProvider: (process.env.SRI_LANKA_PAYMENT_PROVIDER === "payments_lk" ? "payments_lk" : "stripe") as
    | "stripe"
    | "payments_lk",
  // Where Payments.lk sends the customer back to (site) and our cancel route (API).
  publicSiteUrl: (process.env.PUBLIC_SITE_URL || process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, ""),
  publicApiUrl: (process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT ?? 4000}`).replace(/\/$/, ""),
  // Operational alerts (payment limits, failed refunds). Falls back to the
  // low-stock inbox; with neither set, alerts are only logged.
  adminAlertEmail: process.env.ADMIN_ALERT_EMAIL || process.env.LOW_STOCK_ALERT_EMAIL || "",

  // Set to "true" for local development so `npm run dev` doesn't run the iCal
  // sync / expiry / email cron jobs against whatever database .env points at.
  disableJobs: process.env.DISABLE_JOBS === "true",

  airbnbSyncCron: process.env.AIRBNB_SYNC_CRON ?? "*/30 * * * *",
  bookingHoldMinutes: Number(process.env.BOOKING_HOLD_MINUTES ?? 15),
};
