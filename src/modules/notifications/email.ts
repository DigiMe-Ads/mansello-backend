import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { env } from "@/config/env";

// `family` is a real, documented SMTP transport option (nodemailer forwards
// it straight to Node's socket connect()) but @types/nodemailer doesn't
// declare it — this widened type sidesteps that gap without an `as any`.
// See index.ts for why it's set.
type GmailTransportOptions = SMTPTransport.Options & { family?: number };

// Gmail SMTP + an app password (not a third-party email service) — sends as
// the real gmail.com mailbox directly. Needs 2-Step Verification enabled on
// that Google account and an app password generated from it — but once
// generated, the app password keeps working even if the account's
// verification phone number is later changed; it's tied to 2FA being on,
// not to any specific phone number.
const transportOptions: GmailTransportOptions = {
  service: "gmail",
  auth: { user: env.gmail.user, pass: env.gmail.appPassword },
  // Belt-and-suspenders alongside the global dns.setDefaultResultOrder in
  // index.ts — forces this connection over IPv4 even if something else ever
  // changes the process-wide DNS order.
  family: 4,
};

const transporter = env.gmail.user && env.gmail.appPassword ? nodemailer.createTransport(transportOptions) : null;

async function send(to: string, subject: string, html: string) {
  if (!transporter) {
    console.log(`[email:noop] to=${to} subject="${subject}"`);
    return;
  }
  await transporter.sendMail({ from: env.emailFrom, to, subject, html });
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
