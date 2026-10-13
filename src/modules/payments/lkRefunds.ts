import type { Refund as PaymentsLkRefund, Payment as PaymentsLkPayment } from "@payments-lk/node";
import { prisma } from "@/db/prisma";
import { alertAdmin } from "@/modules/notifications/email";
import { MAX_REFUND_ATTEMPTS, ReturnKind, requestRefund, toCents } from "./paymentsLk";

// Refund state for Payments.lk-paid bookings and orders. A refund is only
// *requested* here (refundStatus "pending"); the refund.succeeded /
// refund.failed webhook settles it. A failed one is retried daily by the
// refund job (Payable can't refund a card payment until it has settled),
// up to MAX_REFUND_ATTEMPTS, and the admin is told each time.

type PaymentFields = {
  paymentsLkRefundId?: string | null;
  refundStatus?: string | null;
  refundAttempts?: number;
  refundError?: string | null;
  refundedChargeAmount?: number | null;
  paymentNote?: string | null;
};

function save(kind: ReturnKind, id: string, data: PaymentFields) {
  return kind === "booking"
    ? prisma.booking.update({ where: { id }, data })
    : prisma.order.update({ where: { id }, data });
}

async function load(kind: ReturnKind, id: string) {
  if (kind === "booking") {
    const b = await prisma.booking.findUniqueOrThrow({ where: { id } });
    return {
      ...b,
      // A booking may be refunded in part (cancellation policy): the same
      // share of the LKR actually charged, never reconverted at today's rate.
      refundCents: Math.round(
        toCents(b.chargeAmount) * Math.min(1, Number(b.refundAmount ?? b.totalPrice) / Number(b.totalPrice))
      ),
    };
  }
  const o = await prisma.order.findUniqueOrThrow({ where: { id } });
  return { ...o, refundCents: toCents(o.chargeAmount) }; // orders are refunded in full
}

const label = (kind: ReturnKind, id: string) => `${kind} ${id}`;

// Starts (or retries) the refund of whatever load() says is owed.
export async function startLkRefund(kind: ReturnKind, id: string, reason?: string): Promise<"pending" | "failed"> {
  const record = await load(kind, id);
  const attempt = record.refundAttempts + 1;
  try {
    if (!record.paymentsLkPaymentId) throw new Error("No Payments.lk payment recorded for this " + kind);
    if (record.refundCents < 100) throw new Error(`Refund of ${record.refundCents} cents is below the Rs. 1 minimum`);
    const refund = await requestRefund({
      kind,
      id,
      paymentId: record.paymentsLkPaymentId,
      amountCents: record.refundCents,
      attempt,
      reason,
    });
    await save(kind, id, {
      paymentsLkRefundId: refund.id,
      refundStatus: refund.status === "succeeded" ? "succeeded" : refund.status === "failed" ? "failed" : "pending",
      refundAttempts: attempt,
      refundError: refund.failureMessage,
    });
    return refund.status === "failed" ? "failed" : "pending";
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[payments-lk] refund request failed for ${label(kind, id)}:`, message);
    await save(kind, id, { refundStatus: "failed", refundAttempts: attempt, refundError: message });
    await alertRefundFailed(kind, id, record.refundCents, attempt, message);
    return "failed";
  }
}

async function alertRefundFailed(kind: ReturnKind, id: string, cents: number, attempt: number, why: string) {
  const retrying = attempt < MAX_REFUND_ATTEMPTS;
  await alertAdmin(`Payments.lk refund failed (${label(kind, id)})`, [
    `A refund of LKR ${(cents / 100).toFixed(2)} for ${label(kind, id)} failed: ${why}`,
    retrying
      ? `This is attempt ${attempt} of ${MAX_REFUND_ATTEMPTS}; it will be retried automatically tomorrow (card payments can only be refunded once they have settled).`
      : `That was the last automatic attempt — please refund it from the Payments.lk dashboard.`,
  ]);
}

// Daily: retry every failed Payments.lk refund that still has attempts left.
export async function retryFailedLkRefunds() {
  const due = { paymentProvider: "payments_lk", refundStatus: "failed", refundAttempts: { lt: MAX_REFUND_ATTEMPTS } };
  const [bookings, orders] = await Promise.all([
    prisma.booking.findMany({ where: due, select: { id: true } }),
    prisma.order.findMany({ where: due, select: { id: true } }),
  ]);
  for (const b of bookings) await startLkRefund("booking", b.id);
  for (const o of orders) await startLkRefund("order", o.id);
  return bookings.length + orders.length;
}

// refund.succeeded / refund.failed. Matched on the payment, so refunds made
// from the Payments.lk dashboard (or approved after an AI agent prepared
// them) are recorded too — and flagged for the admin rather than acted on:
// a partial refund doesn't mean the stay or order is off. Safe to run twice.
export async function applyRefundEvent(
  type: "refund.succeeded" | "refund.failed",
  refund: PaymentsLkRefund & { payment: PaymentsLkPayment }
) {
  const booking = await prisma.booking.findUnique({ where: { paymentsLkPaymentId: refund.paymentId } });
  const order = booking ? null : await prisma.order.findUnique({ where: { paymentsLkPaymentId: refund.paymentId } });
  const record = booking ?? order;
  if (!record) {
    console.warn(`[payments-lk] ${type} ${refund.id} for unknown payment ${refund.paymentId}`);
    return;
  }
  const kind: ReturnKind = booking ? "booking" : "order";
  const refundedChargeAmount = refund.payment.refundedCents / 100;

  if (refund.id === record.paymentsLkRefundId) {
    if (type === "refund.succeeded") {
      await save(kind, record.id, { refundStatus: "succeeded", refundError: null, refundedChargeAmount });
    } else if (record.refundStatus !== "failed" || record.refundError !== refund.failureMessage) {
      await save(kind, record.id, { refundStatus: "failed", refundError: refund.failureMessage ?? "Refund failed" });
      await alertRefundFailed(kind, record.id, refund.amountCents, record.refundAttempts, refund.failureMessage ?? "unknown reason");
    }
    return;
  }

  // Not one we asked for.
  if (type === "refund.failed") {
    console.warn(`[payments-lk] external refund ${refund.id} on ${label(kind, record.id)} failed`);
    return;
  }
  if (record.paymentNote?.includes(refund.id)) return; // already recorded (redelivery)
  const note =
    `Refund of LKR ${(refund.amountCents / 100).toFixed(2)} (${refund.id}) was made outside the admin ` +
    `(Payments.lk dashboard) on ${refund.succeededAt ?? refund.createdAt}. Check whether this ${kind} should change.`;
  await save(kind, record.id, {
    refundedChargeAmount,
    paymentNote: record.paymentNote ? `${record.paymentNote}\n${note}` : note,
  });
  await alertAdmin(`Payments.lk refund made outside the admin (${label(kind, record.id)})`, [note]);
}
