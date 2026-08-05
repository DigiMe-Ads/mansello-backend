import Stripe from "stripe";
import { env } from "@/config/env";

export const stripeClients = {
  italy: new Stripe(env.stripe.italy.secretKey, { apiVersion: "2024-06-20" }),
  sri_lanka: new Stripe(env.stripe.sriLanka.secretKey, { apiVersion: "2024-06-20" }),
} as const;

export type StripeAccountRef = keyof typeof stripeClients;

export function getStripeClient(accountRef: StripeAccountRef) {
  return stripeClients[accountRef];
}

export function getWebhookSecret(accountRef: StripeAccountRef) {
  return accountRef === "italy" ? env.stripe.italy.webhookSecret : env.stripe.sriLanka.webhookSecret;
}
