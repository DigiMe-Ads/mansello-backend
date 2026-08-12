import { Resend } from "resend";
import { env } from "@/config/env";

// Sends over Resend's HTTPS API rather than raw SMTP. This project tried
// Gmail SMTP directly first (no third-party service, sends as the real
// mailbox) — worked everywhere except Railway, whose outbound network times
// out connecting on both 465 and 587 (ETIMEDOUT/CONN), which matches how a
// lot of PaaS/cloud egress blocks the SMTP protocol wholesale regardless of
// port. An HTTPS API call sidesteps that entirely — same transport this app
// already uses for Stripe and S3, so there's nothing new to be blocked.
const resend = env.resendApiKey ? new Resend(env.resendApiKey) : null;

async function send(to: string, subject: string, html: string) {
  if (!resend) {
    console.log(`[email:noop] to=${to} subject="${subject}"`);
    return;
  }

  const { error } = await resend.emails.send({
    from: env.emailFrom,
    to,
    subject,
    html,
    // Sent "from" the verified mansello.com domain (required — you can't
    // send as @gmail.com through a third-party service, SPF/DKIM would
    // reject it), but replies still land in the real inbox that's actually
    // monitored day to day.
    replyTo: env.emailReplyTo || undefined,
  });
  if (error) throw new Error(`Resend error: ${error.message}`);
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

export function sendGuestInfoRequest(to: string, guestName: string, propertyName: string, link: string) {
  return send(
    to,
    `A few details for your stay at ${propertyName}`,
    `<p>Hi ${guestName},</p><p>Before your stay at ${propertyName}, could you fill in a few details for us?</p><p><a href="${link}">${link}</a></p>`
  );
}
