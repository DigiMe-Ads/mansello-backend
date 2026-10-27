import { createHmac, timingSafeEqual } from "crypto";
import { env } from "@/config/env";
import { ApiError } from "@/utils/ApiError";

// NOWPayments — pay in cryptocurrency, offered next to card payments on both
// sites (Italy and Sri Lanka bookings, and marketplace orders). Same shape as
// Payments.lk: we create a hosted invoice, send the customer to it, and only
// ever confirm from NOWPayments' signed IPN (webhook) — the customer coming
// back to success_url proves nothing.
//
// Prices are sent in the booking/order's own currency (EUR or USD) and the
// customer picks the coin on NOWPayments' page. Refunds can't be automatic
// (a crypto payment goes back to a wallet address the customer has to give
// us), so a cancellation that owes money records a note and emails the admin.

const API = "https://api.nowpayments.io/v1";

export type CryptoKind = "booking" | "order";

export function cryptoEnabled() {
  return Boolean(env.nowPayments.apiKey && env.nowPayments.ipnSecret);
}

const UNAVAILABLE = "Crypto payments are temporarily unavailable — please pay by card or contact us.";

function unavailable(logReason: string) {
  console.error(`[nowpayments] unavailable: ${logReason}`);
  return new ApiError(503, UNAVAILABLE);
}

// "booking:<uuid>" / "order:<uuid>" — tells the IPN handler which table to
// look in without guessing.
export function cryptoOrderId(kind: CryptoKind, id: string) {
  return `${kind}:${id}`;
}

export function parseCryptoOrderId(value: unknown): { kind: CryptoKind; id: string } | null {
  if (typeof value !== "string") return null;
  const [kind, id] = value.split(":");
  if ((kind !== "booking" && kind !== "order") || !id) return null;
  return { kind, id };
}

// The cancel link carries an HMAC of kind:id so nobody can release someone
// else's hold by guessing an id. Domain-separated from the Payments.lk one.
function cancelSignature(kind: CryptoKind, id: string) {
  return createHmac("sha256", env.jwtAccessSecret).update(`nowpayments-cancel:${kind}:${id}`).digest("hex");
}

export function verifyCryptoCancelSignature(kind: string, id: string, sig: string) {
  if (kind !== "booking" && kind !== "order") return false;
  const expected = Buffer.from(cancelSignature(kind, id));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function cancelUrl(kind: CryptoKind, id: string) {
  const query = new URLSearchParams({ kind, id, sig: cancelSignature(kind, id) });
  return `${env.publicApiUrl}/api/nowpayments/return/cancel?${query}`;
}

export interface Invoice {
  id: string;
  invoice_url: string;
}

/** Opens a hosted crypto invoice for this amount (in EUR/USD — the customer picks the coin). */
export async function createInvoice(params: {
  kind: CryptoKind;
  id: string;
  amount: number;
  currency: string;
  description: string;
  successUrl: string;
}): Promise<Invoice> {
  if (!cryptoEnabled()) throw unavailable("NOW_PAYMENTS_API / NOW_PAYMENTS_IPN not configured");
  let res: Response;
  try {
    res = await fetch(`${API}/invoice`, {
      method: "POST",
      headers: { "x-api-key": env.nowPayments.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        price_amount: Math.round(params.amount * 100) / 100,
        price_currency: params.currency.toLowerCase(),
        order_id: cryptoOrderId(params.kind, params.id),
        order_description: params.description.slice(0, 200),
        ipn_callback_url: `${env.publicApiUrl}/api/webhooks/nowpayments`,
        success_url: params.successUrl,
        cancel_url: cancelUrl(params.kind, params.id),
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw unavailable(`connection: ${(err as Error).message}`);
  }
  const body = (await res.json().catch(() => ({}))) as Partial<Invoice> & { message?: string; code?: string };
  if (!res.ok || !body.id || !body.invoice_url) {
    console.error(`[nowpayments] create invoice failed: ${res.status} ${body.code ?? ""} ${body.message ?? ""}`);
    if (res.status === 400 && /amount/i.test(body.message ?? "")) {
      throw ApiError.badRequest("This amount is too small to pay in crypto — please pay by card.");
    }
    throw unavailable(`HTTP ${res.status} ${body.code ?? ""}`);
  }
  return { id: String(body.id), invoice_url: body.invoice_url };
}

// --- IPN ---------------------------------------------------------------------
// NOWPayments signs the JSON body with the IPN secret: HMAC-SHA512 over the
// body re-serialised with its keys sorted (recursively), sent hex-encoded in
// the x-nowpayments-sig header.

// A copy of NOWPayments' own reference sortObject — including its quirk of
// turning arrays into index-keyed objects — so our signature is computed
// byte-for-byte the way theirs is.
function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      const v = obj[key];
      result[key] = v && typeof v === "object" ? sortKeys(v as Record<string, unknown>) : v;
      return result;
    }, {});
}

export function ipnSignature(body: unknown, secret = env.nowPayments.ipnSecret) {
  return createHmac("sha512", secret).update(JSON.stringify(sortKeys((body ?? {}) as Record<string, unknown>))).digest("hex");
}

export function verifyIpn(body: unknown, header: unknown): boolean {
  if (!env.nowPayments.ipnSecret || typeof header !== "string" || !header) return false;
  const expected = Buffer.from(ipnSignature(body));
  const given = Buffer.from(header.toLowerCase());
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export interface IpnPayload {
  payment_id: number | string;
  invoice_id?: number | string | null;
  payment_status: string;
  order_id?: string | null;
  price_amount: number | string;
  price_currency: string;
  pay_amount?: number | string;
  actually_paid?: number | string;
  pay_currency?: string;
  outcome_amount?: number | string;
  outcome_currency?: string;
}

// waiting → confirming → confirmed → sending → finished. "finished" is the
// only status that means the money has arrived in full.
export const IN_FLIGHT_STATUSES = ["confirming", "confirmed", "sending"];
export const DEAD_STATUSES = ["failed", "expired"];
