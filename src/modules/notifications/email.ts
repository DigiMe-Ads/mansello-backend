import dns from "dns";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { env } from "@/config/env";

const GMAIL_SMTP_HOST = "smtp.gmail.com";
// 587 (STARTTLS/"submission"), not 465 (implicit TLS) — Railway's outbound
// network times out connecting to 465 (ETIMEDOUT, CONN — nothing to do with
// the app itself, confirmed working locally 8/8 against the same host/auth),
// which matches how a lot of PaaS/cloud egress restricts SMTP ports by
// default. 587 is the standard client-submission port and is more commonly
// left open than 465 for exactly this reason.
const GMAIL_SMTP_PORT = 587;

// `servername` is a real, documented smtp-connection option (TLS SNI +
// certificate hostname override, needed below since `host` becomes a bare
// IP) but @types/nodemailer doesn't declare it — same gap as `family` did.
type GmailTransportOptions = SMTPTransport.Options & { servername?: string };

// Gmail SMTP + an app password (not a third-party email service) — sends as
// the real gmail.com mailbox directly. Needs 2-Step Verification enabled on
// that Google account and an app password generated from it — but once
// generated, the app password keeps working even if the account's
// verification phone number is later changed; it's tied to 2FA being on,
// not to any specific phone number.

// nodemailer does its OWN DNS resolution for the SMTP host (a dns.Resolver
// calling resolve4/resolve6 directly — see node_modules/nodemailer/lib/
// shared/index.js), completely bypassing Node's dns.lookup and therefore
// dns.setDefaultResultOrder in index.ts. It resolves both address families,
// pools them, and picks ONE AT RANDOM to connect to (formatDNSValue) — so on
// a network where IPv6 is advertised but not actually routed, sends fail
// with ECONNREFUSED roughly however often the coin lands on an IPv6
// address. There's also no supported option to pin this: a `family` option
// on the transport is silently dropped (smtp-connection's connect() never
// forwards it to net/tls.connect).
//
// Fix: resolve the IPv4 address ourselves and connect to that IP literal.
// nodemailer's own resolveHostname() short-circuits and skips all of the
// above the moment `host` is already an IP (net.isIP check), so this
// sidesteps the random-pick entirely. `servername` has to be set explicitly
// in that case — nodemailer only defaults it from `host` when `host` isn't
// an IP, and TLS needs the real hostname for SNI + certificate validation.
// Re-resolved on every send rather than cached: it's a cheap lookup, and
// this stays correct if Google ever rotates their frontend IPs.
async function resolveGmailSmtpIPv4(): Promise<string | null> {
  try {
    const addresses = await dns.promises.resolve4(GMAIL_SMTP_HOST);
    return addresses[Math.floor(Math.random() * addresses.length)] ?? null;
  } catch {
    return null;
  }
}

async function send(to: string, subject: string, html: string) {
  if (!env.gmail.user || !env.gmail.appPassword) {
    console.log(`[email:noop] to=${to} subject="${subject}"`);
    return;
  }

  const ipv4Host = await resolveGmailSmtpIPv4();
  const transportOptions: GmailTransportOptions = {
    // Falls back to the hostname (re-exposed to the IPv6 coin flip) only if
    // our own IPv4 lookup itself fails — better than not sending at all.
    host: ipv4Host ?? GMAIL_SMTP_HOST,
    port: GMAIL_SMTP_PORT,
    secure: false, // 587 = STARTTLS, negotiated after connecting — not implicit TLS like 465
    requireTLS: true, // fail loudly rather than silently fall back to a plaintext connection
    servername: GMAIL_SMTP_HOST,
    auth: { user: env.gmail.user, pass: env.gmail.appPassword },
  };
  const transporter = nodemailer.createTransport(transportOptions);

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
