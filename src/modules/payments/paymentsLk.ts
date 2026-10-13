import { createHmac, timingSafeEqual } from "crypto";
import {
  PaymentsLk,
  ApiError as PaymentsLkApiError,
  ConnectionError as PaymentsLkConnectionError,
  type Refund as PaymentsLkRefund,
} from "@payments-lk/node";
import { env } from "@/config/env";
import { ApiError } from "@/utils/ApiError";

// Payments.lk hosted checkout for Sri Lanka — Dona's Villa bookings and
// marketplace orders. See BACKEND_CHANGES_VARIANTS_CALENDAR_PAYMENTS_LK.md §3.
// Payments.lk only works in LKR (whole cents), so USD prices are converted
// when the checkout is created and the result is stored on the
// booking/order; refunds are a share of that stored LKR amount, never
// reconverted.

let client: PaymentsLk | null = null;

export function paymentsLk(): PaymentsLk {
  if (!env.paymentsLk.secretKey) throw unavailable("PAYMENTS_LK key not configured");
  client ??= new PaymentsLk(env.paymentsLk.secretKey);
  return client;
}

// Sri Lanka checkouts go through Payments.lk only once the cutover switch is
// flipped. Italy never does.
export function usesPaymentsLk(stripeAccountRef: string): boolean {
  return stripeAccountRef === "sri_lanka" && env.sriLankaPaymentProvider === "payments_lk";
}

const UNAVAILABLE_MESSAGE = "Card payments are temporarily unavailable — please contact us to complete your booking.";

function unavailable(logReason: string) {
  console.error(`[payments-lk] unavailable: ${logReason}`);
  return new ApiError(503, UNAVAILABLE_MESSAGE);
}

// --- USD → LKR ---------------------------------------------------------------

const RATE_URL = "https://open.er-api.com/v6/latest/USD";
const RATE_TTL_MS = 24 * 60 * 60 * 1000;
const STALE_RATE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;
let cachedRate: { rate: number; fetchedAt: number } | null = null;

// One daily rate (cached in memory for a day). A stale rate up to a week old
// is still used if the source is briefly down; past that, card payments stop
// with a friendly message rather than charging at a guessed rate.
// USD_LKR_RATE overrides it entirely.
export async function usdToLkrRate(): Promise<number> {
  if (env.paymentsLk.usdLkrRateOverride) return env.paymentsLk.usdLkrRateOverride;
  if (cachedRate && Date.now() - cachedRate.fetchedAt < RATE_TTL_MS) return cachedRate.rate;

  try {
    const res = await fetch(RATE_URL, { signal: AbortSignal.timeout(10_000) });
    const body = (await res.json()) as { result?: string; rates?: Record<string, number> };
    const rate = body.rates?.LKR;
    // Sanity bounds: a wildly wrong rate must never reach a card.
    if (body.result !== "success" || typeof rate !== "number" || rate < 100 || rate > 1000) {
      throw new Error(`unexpected rate response (${body.result}, ${rate})`);
    }
    cachedRate = { rate, fetchedAt: Date.now() };
    return rate;
  } catch (err) {
    if (cachedRate && Date.now() - cachedRate.fetchedAt < STALE_RATE_LIMIT_MS) {
      console.warn(`[payments-lk] USD→LKR rate refresh failed, using cached rate: ${(err as Error).message}`);
      return cachedRate.rate;
    }
    throw unavailable(`no USD→LKR rate: ${(err as Error).message}`);
  }
}

export async function lkrCharge(totalUsd: number) {
  const fxRate = await usdToLkrRate();
  const chargeAmount = Math.round(totalUsd * fxRate * 100) / 100;
  return { fxRate, chargeAmount, chargeCurrency: "lkr" as const };
}

// Whole LKR cents, as the API wants them — never a float.
export function toCents(amount: unknown): number {
  return Math.round(Number(amount) * 100);
}

// --- Checkout ----------------------------------------------------------------

export type ReturnKind = "booking" | "order";

// The cancel link carries an HMAC of kind:id, so nobody can cancel someone
// else's hold by guessing an id. Domain-separated from every other use of
// the key.
function cancelSignature(kind: ReturnKind, id: string) {
  return createHmac("sha256", env.jwtAccessSecret).update(`payments-lk-cancel:${kind}:${id}`).digest("hex");
}

export function verifyCancelSignature(kind: string, id: string, sig: string): boolean {
  if (kind !== "booking" && kind !== "order") return false;
  const expected = Buffer.from(cancelSignature(kind, id));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function cancelUrl(kind: ReturnKind, id: string) {
  const query = new URLSearchParams({ kind, id, sig: cancelSignature(kind, id) });
  return `${env.publicApiUrl}/api/payments-lk/return/cancel?${query}`;
}

// The idempotency key is the booking/order id, so a retried request can never
// open a second checkout for it. Payments.lk's own errors are turned into
// messages a customer can act on; details go to the log only.
export async function createCheckout(params: {
  kind: ReturnKind;
  id: string;
  amountCents: number;
  description: string;
  successUrl: string;
}) {
  try {
    const checkout = await paymentsLk().checkouts.create(
      {
        amountCents: params.amountCents,
        description: params.description.slice(0, 200),
        reference: params.id,
        successUrl: params.successUrl,
        cancelUrl: cancelUrl(params.kind, params.id),
      },
      { idempotencyKey: `${params.kind}-${params.id}` }
    );
    return { id: checkout.id, url: checkout.url, expiresAt: checkout.expiresAt };
  } catch (err) {
    throw toCustomerError(err, "create checkout");
  }
}

function toCustomerError(err: unknown, action: string): Error {
  if (err instanceof PaymentsLkApiError) {
    console.error(
      `[payments-lk] ${action} failed: ${err.status} ${err.code}${err.reason ? `/${err.reason}` : ""} trace=${err.traceId}`
    );
    if (err.reason === "monthly_limit_reached") return unavailable("monthly limit reached");
    if (err.status === 400 || err.status === 422) {
      // Typically the amount: a checkout takes Rs. 10 to Rs. 1,000,000.
      return ApiError.badRequest(
        "This amount can't be paid by card online — please contact us and we'll arrange payment."
      );
    }
    return unavailable(`${err.code}${err.reason ? `/${err.reason}` : ""}`);
  }
  if (err instanceof PaymentsLkConnectionError) return unavailable(`connection: ${err.message}`);
  return err as Error;
}

export async function retrieveCheckout(checkoutId: string) {
  return paymentsLk().checkouts.retrieve(checkoutId);
}

// --- Refunds -----------------------------------------------------------------

export const MAX_REFUND_ATTEMPTS = 5;

// Refunds are asynchronous: this records a pending refund at Payments.lk and
// refund.succeeded / refund.failed (webhook) says how it ended. A card
// payment can only be refunded once it has settled (from the next bank
// working day), so an early request fails and is retried by the daily
// refund job. `attempt` makes each retry a distinct request.
export async function requestRefund(params: {
  kind: ReturnKind;
  id: string;
  paymentId: string;
  amountCents: number;
  attempt: number;
  reason?: string;
}): Promise<PaymentsLkRefund> {
  try {
    return await paymentsLk().refunds.create(
      { paymentId: params.paymentId, amountCents: params.amountCents, reason: params.reason?.slice(0, 200) },
      { idempotencyKey: `refund-${params.kind}-${params.id}-${params.attempt}` }
    );
  } catch (err) {
    if (err instanceof PaymentsLkApiError) {
      throw new Error(`Payments.lk refused the refund: ${err.code}${err.reason ? `/${err.reason}` : ""} — ${err.apiMessage}`);
    }
    throw err;
  }
}
