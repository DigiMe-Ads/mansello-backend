import { Prisma } from "@prisma/client";
import { prisma } from "@/db/prisma";
import { env } from "@/config/env";
import { ApiError } from "@/utils/ApiError";
import { sendGuestInfoRequest } from "@/modules/notifications/email";
import { GUEST_DOCUMENTS_PREFIX, signDocumentUrl } from "@/modules/uploads/imageUpload";

const TEMPLATE_ID = "default";
const EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;

export type GuestInfoFieldType =
  | "text"
  | "textarea"
  | "date"
  | "number"
  | "select"
  | "checkbox"
  | "file";

export interface GuestInfoField {
  id: string; // stable per field, client-generated — the key answers are stored under
  label: string;
  type: GuestInfoFieldType;
  required: boolean;
  options?: string[]; // only meaningful when type is "select"
}

// A "file" field's answer is the uploaded document URL(s) — collected via
// the separate uploads endpoint below, not raw bytes in the submit payload.
export type GuestInfoAnswerValue = string | boolean | string[];
export type GuestInfoAnswers = Record<string, GuestInfoAnswerValue>;

// -- Shared template (Settings) ----------------------------------------------

export async function getGuestInfoTemplate() {
  const row = await prisma.guestInfoFormTemplate.findUnique({ where: { id: TEMPLATE_ID } });
  if (!row) return { fields: [] as GuestInfoField[], updatedAt: null as Date | null };
  return { fields: row.fields as unknown as GuestInfoField[], updatedAt: row.updatedAt };
}

export async function updateGuestInfoTemplate(fields: GuestInfoField[]) {
  const row = await prisma.guestInfoFormTemplate.upsert({
    where: { id: TEMPLATE_ID },
    create: { id: TEMPLATE_ID, fields: fields as unknown as Prisma.InputJsonValue },
    update: { fields: fields as unknown as Prisma.InputJsonValue },
  });
  return { fields: row.fields as unknown as GuestInfoField[], updatedAt: row.updatedAt };
}

// -- Per-booking requests (admin) --------------------------------------------

function buildLink(token: string) {
  return `${env.frontendUrl}/booking-info/${token}`;
}

// Status is computed lazily rather than flipped by a cron job — a "pending"
// row past its expiresAt reads as "expired" everywhere it's returned, no
// scheduled job needed to keep it accurate at rest (see doc §1).
function resolveStatus(row: { status: string; expiresAt: Date }): "pending" | "submitted" | "expired" {
  if (row.status === "pending" && new Date() > row.expiresAt) return "expired";
  return row.status as "pending" | "submitted";
}

function toAdminShape<T extends { status: string; expiresAt: Date; token: string }>(row: T) {
  return { ...row, status: resolveStatus(row), link: buildLink(row.token) };
}

// `booking` is passed in already-fetched (with its property) so the caller
// can 404/scope-check before this ever runs — same division of labor as
// modules/offers/controller.ts's assertScope.
export async function createBookingInfoRequest(booking: {
  id: string;
  guestName: string;
  guestEmail: string;
  property: { name: string };
}) {
  const template = await getGuestInfoTemplate();
  const expiresAt = new Date(Date.now() + EXPIRY_MS);

  const row = await prisma.bookingInfoRequest.create({
    data: {
      bookingId: booking.id,
      fields: template.fields as unknown as Prisma.InputJsonValue,
      expiresAt,
    },
  });

  await sendGuestInfoRequest(booking.guestEmail, booking.guestName, booking.property.name, buildLink(row.token));

  return toAdminShape(row);
}

// File answers are stored as private-bucket keys; the admin gets each one
// swapped for a 15-minute signed URL, everything else unchanged. (A legacy
// answer that's already a full URL is passed through as-is.)
async function withSignedDocumentUrls(answers: Prisma.JsonValue | null) {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return answers;
  const signed: Record<string, unknown> = {};
  for (const [fieldId, value] of Object.entries(answers)) {
    signed[fieldId] = Array.isArray(value)
      ? await Promise.all(
          value.map((v) =>
            typeof v === "string" && v.startsWith(GUEST_DOCUMENTS_PREFIX) ? signDocumentUrl(v) : v
          )
        )
      : value;
  }
  return signed;
}

export async function listBookingInfoRequests(bookingId: string) {
  const rows = await prisma.bookingInfoRequest.findMany({
    where: { bookingId },
    orderBy: { createdAt: "desc" },
  });
  return Promise.all(
    rows.map(async (row) => ({ ...toAdminShape(row), answers: await withSignedDocumentUrls(row.answers) }))
  );
}

// -- Public, token-gated ------------------------------------------------------

export async function getBookingInfoRequestByToken(token: string) {
  const row = await prisma.bookingInfoRequest.findUnique({
    where: { token },
    include: { booking: { include: { property: true } } },
  });
  if (!row) throw ApiError.notFound("Not found");

  return {
    status: resolveStatus(row),
    propertyName: row.booking.property.name,
    guestName: row.booking.guestName,
    checkIn: row.booking.checkIn,
    checkOut: row.booking.checkOut,
    fields: row.fields as unknown as GuestInfoField[],
    expiresAt: row.expiresAt,
  };
}

// Presence, not truthiness — a deliberate `false` on a required checkbox is
// still an answer; only "never answered" (a blank string or an empty file
// array) counts as missing.
function isAnswered(value: GuestInfoAnswerValue | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

// Shared by submit and the file-upload endpoint below — both are only valid
// against a request that hasn't already been finished one way or the other.
async function getActionableRequest(token: string) {
  const row = await prisma.bookingInfoRequest.findUnique({ where: { token } });
  if (!row) throw ApiError.notFound("Not found");

  const status = resolveStatus(row);
  if (status === "submitted") throw ApiError.conflict("This form has already been submitted");
  if (status === "expired") throw ApiError.gone("This link has expired");

  return row;
}

// Doesn't persist anything — the caller uploads to S3/R2 first and only then
// includes the resulting URL(s) in the eventual submit payload, same as any
// other field. This just gates the upload behind the same token/status
// rules as submit, so a dead link can't be used to fill a bucket either.
export function assertUploadable(token: string) {
  return getActionableRequest(token);
}

const MAX_TEXT_ANSWER = 5000;
const ISSUED_KEY_SUFFIX = /^[0-9a-f-]{36}\.(jpg|png|webp|pdf)$/;

// Answers must match the form they were sent for (BACKEND_SECURITY_AUDIT.md
// M2): only known field ids, the right value type per field, and every file
// answer must be a document key this backend issued for THIS request — so a
// guest can't plant an arbitrary link for the admin to click.
function assertAnswersMatchFields(requestId: string, fields: GuestInfoField[], answers: GuestInfoAnswers) {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const prefix = `${GUEST_DOCUMENTS_PREFIX}${requestId}/`;
  const isIssuedKey = (v: unknown) =>
    typeof v === "string" && v.startsWith(prefix) && ISSUED_KEY_SUFFIX.test(v.slice(prefix.length));

  for (const [fieldId, value] of Object.entries(answers)) {
    const field = byId.get(fieldId);
    if (!field) throw ApiError.badRequest("The form has changed — please reload the page and try again");
    const label = `"${field.label}"`;

    if (field.type === "file") {
      if (!Array.isArray(value) || !value.every(isIssuedKey)) {
        throw ApiError.badRequest(`Please re-upload the file(s) for ${label}`);
      }
    } else if (field.type === "checkbox") {
      if (typeof value !== "boolean") throw ApiError.badRequest(`${label} must be ticked or unticked`);
    } else {
      if (typeof value !== "string") throw ApiError.badRequest(`${label} must be text`);
      if (value.length > MAX_TEXT_ANSWER) {
        throw ApiError.badRequest(`${label} is too long (max ${MAX_TEXT_ANSWER} characters)`);
      }
      if (field.type === "select" && field.options?.length && value && !field.options.includes(value)) {
        throw ApiError.badRequest(`Please choose one of the options for ${label}`);
      }
    }
  }
}

export async function submitBookingInfoRequest(token: string, answers: GuestInfoAnswers) {
  const row = await getActionableRequest(token);

  const fields = row.fields as unknown as GuestInfoField[];
  assertAnswersMatchFields(row.id, fields, answers);
  const missing = fields.filter((field) => field.required && !isAnswered(answers[field.id]));
  if (missing.length > 0) {
    throw ApiError.badRequest(
      "Please fill in all required fields",
      missing.map((field) => ({ fieldId: field.id, label: field.label }))
    );
  }

  const updated = await prisma.bookingInfoRequest.update({
    where: { token },
    data: {
      answers: answers as unknown as Prisma.InputJsonValue,
      status: "submitted",
      submittedAt: new Date(),
    },
  });

  return { status: "submitted" as const, submittedAt: updated.submittedAt };
}
