import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:3000",

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

  resendApiKey: process.env.RESEND_API_KEY ?? "",
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
