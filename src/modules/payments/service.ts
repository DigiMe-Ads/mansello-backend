import { getStripeClient, StripeAccountRef } from "./stripeClients";

export async function createPaymentIntent(
  accountRef: StripeAccountRef,
  amount: number,
  currency: string,
  bookingId: string
) {
  const stripe = getStripeClient(accountRef);
  console.log(
    `[stripe:${accountRef}] creating PaymentIntent bookingId=${bookingId} amount=${amount} ${currency}`
  );
  const intent = await stripe.paymentIntents.create({
    amount: Math.round(amount * 100),
    currency,
    metadata: { bookingId },
    automatic_payment_methods: { enabled: true },
  });
  console.log(`[stripe:${accountRef}] created PaymentIntent ${intent.id} for booking ${bookingId}`);
  return intent;
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
