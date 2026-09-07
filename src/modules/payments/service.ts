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

export async function refundPaymentIntent(
  accountRef: StripeAccountRef,
  paymentIntentId: string,
  amount: number
) {
  if (amount <= 0) return null;
  const stripe = getStripeClient(accountRef);
  console.log(`[stripe:${accountRef}] refunding PaymentIntent ${paymentIntentId} amount=${amount}`);
  const refund = await stripe.refunds.create({
    payment_intent: paymentIntentId,
    amount: Math.round(amount * 100),
  });
  console.log(`[stripe:${accountRef}] refund ${refund.id} status=${refund.status}`);
  return refund;
}
