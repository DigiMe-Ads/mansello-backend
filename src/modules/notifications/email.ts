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

// Every interpolated value is escaped — names come from public forms, and
// these go out from our verified domain (BACKEND_SECURITY_AUDIT.md M5).
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function sendBookingConfirmation(to: string, guestName: string, propertyName: string, checkIn: string, checkOut: string) {
  return send(
    to,
    `Your booking at ${propertyName} is confirmed`,
    `<p>Hi ${escapeHtml(guestName)},</p><p>Your stay at ${escapeHtml(propertyName)} from ${escapeHtml(checkIn)} to ${escapeHtml(checkOut)} is confirmed.</p>`
  );
}

// Sent when a payment arrived after the booking hold expired and the dates
// had been taken in the meantime — the charge has been refunded in full.
export function sendLatePaymentRefund(to: string, guestName: string, propertyName: string, checkIn: string, checkOut: string) {
  return send(
    to,
    `Your payment for ${propertyName} has been refunded`,
    `<p>Hi ${escapeHtml(guestName)},</p><p>Your payment for ${escapeHtml(propertyName)} (${escapeHtml(checkIn)} to ${escapeHtml(checkOut)}) arrived after your ${env.bookingHoldMinutes}-minute hold had expired, and those dates have since been booked. We've refunded the full amount — it should appear on your statement within 5–10 business days.</p><p>We're sorry for the trouble. Please check the calendar for other dates, or reply to this email and we'll help.</p>`
  );
}

export function sendLowStockAlert(to: string, productName: string, quantityOnHand: number) {
  return send(
    to,
    `Low stock: ${productName}`,
    `<p>${escapeHtml(productName)} is down to ${quantityOnHand} units.</p>`
  );
}

export function sendGuestInfoRequest(to: string, guestName: string, propertyName: string, link: string) {
  const safeLink = escapeHtml(link);
  return send(
    to,
    `A few details for your stay at ${propertyName}`,
    `<p>Hi ${escapeHtml(guestName)},</p><p>Before your stay at ${escapeHtml(propertyName)}, could you fill in a few details for us?</p><p><a href="${safeLink}">${safeLink}</a></p>`
  );
}
