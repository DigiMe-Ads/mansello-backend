import { Resend } from "resend";
import { env } from "@/config/env";

const resend = env.resendApiKey ? new Resend(env.resendApiKey) : null;

async function send(to: string, subject: string, html: string) {
  if (!resend) {
    console.log(`[email:noop] to=${to} subject="${subject}"`);
    return;
  }
  await resend.emails.send({ from: env.emailFrom, to, subject, html });
}

export function sendBookingConfirmation(to: string, guestName: string, propertyName: string, checkIn: string, checkOut: string) {
  return send(
    to,
    `Your booking at ${propertyName} is confirmed`,
    `<p>Hi ${guestName},</p><p>Your stay at ${propertyName} from ${checkIn} to ${checkOut} is confirmed.</p>`
  );
}

export function sendOrderConfirmation(to: string, customerName: string, orderId: string) {
  return send(
    to,
    `Order ${orderId} confirmed`,
    `<p>Hi ${customerName},</p><p>Your order ${orderId} has been confirmed and will ship soon. Payment is cash on delivery.</p>`
  );
}

export function sendLowStockAlert(to: string, productName: string, quantityOnHand: number) {
  return send(
    to,
    `Low stock: ${productName}`,
    `<p>${productName} is down to ${quantityOnHand} units.</p>`
  );
}
