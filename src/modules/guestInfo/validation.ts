import { z } from "zod";

const fieldTypeEnum = z.enum(["text", "textarea", "date", "number", "select", "checkbox", "file"]);

// Admin-authored content, not public input — validated for shape only (see
// BACKEND_CHANGES_GUEST_INFO_REQUESTS.md §1), not deeply (e.g. `options`
// isn't required to be present/non-empty even when type is "select").
const guestInfoFieldSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  type: fieldTypeEnum,
  required: z.boolean(),
  options: z.array(z.string()).optional(),
});

export const updateGuestInfoTemplateSchema = z.object({
  body: z.object({
    fields: z.array(guestInfoFieldSchema),
  }),
});

export const submitBookingInfoRequestSchema = z.object({
  body: z.object({
    // A "file" field's answer is the uploaded document URL(s) from
    // POST .../uploads, hence the string[] arm alongside plain text/checkbox.
    answers: z.record(z.union([z.string(), z.boolean(), z.array(z.string())])),
  }),
});
