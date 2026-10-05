import { getStripeClient, StripeAccountRef } from "./stripeClients";

// `metadata` is generic (not just `{ bookingId }`) so this one function can
// back both a villa booking and a marketplace order — see
// BACKEND_CHANGES_MARKETPLACE_PAYMENTS.md. Always includes a `type` key
// (`"booking"` | `"marketplace_order"`) so the webhook handler
// (modules/payments/webhooks.ts) knows which table's row to confirm; the
// caller is responsible for passing it.
export async function createPaymentIntent(
  accountRef: StripeAccountRef,
  amount: number,
  currency: string,
  metadata: Record<string, string>
) {
  const stripe = getStripeClient(accountRef);
  console.log(
    `[stripe:${accountRef}] creating PaymentIntent metadata=${JSON.stringify(metadata)} amount=${amount} ${currency}`
  );
  const intent = await stripe.paymentIntents.create({
    amount: Math.round(amount * 100),
    currency,
    metadata,
    automatic_payment_methods: { enabled: true },
  });
  console.log(`[stripe:${accountRef}] created PaymentIntent ${intent.id} (${JSON.stringify(metadata)})`);
  return intent;
}

export async function getPaymentIntent(accountRef: StripeAccountRef, paymentIntentId: string) {
  const stripe = getStripeClient(accountRef);
  return stripe.paymentIntents.retrieve(paymentIntentId);
}

// `idempotencyKey` should name the business event (e.g. "refund-booking-<id>")
// so a retried or repeated request can never refund the same thing twice —
// Stripe returns the original refund instead of creating a second one.
export async function refundPaymentIntent(
  accountRef: StripeAccountRef,
  paymentIntentId: string,
  amount: number,
  idempotencyKey?: string
) {
  if (amount <= 0) return null;
  const stripe = getStripeClient(accountRef);
  console.log(`[stripe:${accountRef}] refunding PaymentIntent ${paymentIntentId} amount=${amount}`);
  const refund = await stripe.refunds.create(
    { payment_intent: paymentIntentId, amount: Math.round(amount * 100) },
    idempotencyKey ? { idempotencyKey } : undefined
  );
  console.log(`[stripe:${accountRef}] refund ${refund.id} status=${refund.status}`);
  return refund;
}

// Makes an abandoned PaymentIntent unpayable — called when a booking hold or
// a pending order expires/is cancelled, so a guest who returns late can't be
// charged for something that no longer exists (BACKEND_SECURITY_AUDIT.md H2).
// Best-effort: an intent that already succeeded (or was already cancelled)
// can't be cancelled, and that's fine — the webhook backstop handles a late
// success. Never throws.
export async function cancelPaymentIntentQuietly(accountRef: StripeAccountRef, paymentIntentId: string) {
  try {
    await getStripeClient(accountRef).paymentIntents.cancel(paymentIntentId);
    console.log(`[stripe:${accountRef}] cancelled PaymentIntent ${paymentIntentId}`);
  } catch (err) {
    console.warn(`[stripe:${accountRef}] could not cancel PaymentIntent ${paymentIntentId}: ${(err as Error).message}`);
  }
}
