import rateLimit from "express-rate-limit";

// See BACKEND_CHANGES_SEO_SECURITY_HARDENING.md §6.4 — before this, the
// only rate limiter anywhere in the app was the heatmap ingest endpoint's
// own (modules/analytics/routes.ts), which is tuned for a very different
// case (high-volume, fire-and-forget, always-202). These are for the
// public forms a scripted flood could actually abuse (spam, fake orders,
// filling storage with junk documents).
//
// Relies on `app.set("trust proxy", 1)` (src/app.ts) to see the real
// per-visitor IP behind Railway's proxy rather than one shared address.

// Generic public-form guard — contact/newsletter/transport leads,
// marketplace checkout, guest document uploads. Generous enough that a real
// visitor filling out a form a few times (or retrying a failed checkout)
// never notices it.
export const publicFormLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", message: "Too many requests — please try again shortly." },
});

// Stricter — credential-stuffing/brute-force guard on admin login. Counts
// every attempt (can't distinguish a failed password from a successful one
// before the request completes), so a legitimate admin who mistypes their
// password several times in a row will also see this — an accepted
// trade-off for real lockout behavior.
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", message: "Too many login attempts — please try again in 15 minutes." },
});
