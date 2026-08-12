import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  // Comma-separated list, e.g. "https://mansello.vercel.app,https://mansello.com".
  // Trailing slashes stripped defensively — the browser's actual Origin
  // header never has one, so a pasted URL with one would silently never
  // match otherwise. The `cors` package's `origin` option accepts an array
  // natively, so no other code needs to change to allow more than one site.
  corsOrigin: (
    // process.env.CORS_ORIGIN ??
    "https://mansello.com"
  )
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean),
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

  // Plain Gmail SMTP via an app password — sends as the real mailbox
  // directly, no third-party email service or domain/DNS involved. Needs
  // 2-Step Verification enabled on the Google account and an app password
  // generated from it (myaccount.google.com/apppasswords); the app password
  // keeps working even if the account's verification phone number later
  // changes — it's tied to 2FA being on, not to any specific phone number.
  gmail: {
    user: process.env.GMAIL_USER ?? "",
    appPassword: process.env.GMAIL_APP_PASSWORD ?? "",
  },
  // Must match gmail.user exactly (Gmail SMTP overrides/rejects a mismatched
  // From) — a display name is fine, e.g. "Mansello <user@gmail.com>".
  emailFrom: process.env.EMAIL_FROM ?? "Mansello <bookings@mansello.com>",

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
  },

  airbnbSyncCron: process.env.AIRBNB_SYNC_CRON ?? "*/30 * * * *",
  bookingHoldMinutes: Number(process.env.BOOKING_HOLD_MINUTES ?? 15),
};
