import { z } from "zod";
import { ApiError } from "@/utils/ApiError";

export const putContentSchema = z.object({
  body: z.object({
    entries: z.array(z.object({ key: z.string().min(1), value: z.string() })).min(1),
  }),
});

export const deleteContentSchema = z.object({
  body: z.object({
    keys: z.array(z.string().min(1)).min(1),
  }),
});

const MAX_VALUE_BYTES = 16 * 1024;

// Keys whose *value* is a URL (or a newline-separated list of them, same as
// any other multi-line field — see BACKEND_CHANGES_SITE_CONTENT.md §1)
// rather than plain text, recognized by a naming-convention heuristic —
// `key` is otherwise treated as an opaque string throughout this module,
// per the doc's explicit instruction not to parse or validate it against a
// known list. A false positive here just holds an ordinary text field to a
// stricter-than-needed format; a false negative just means one URL-shaped
// field slips this particular check — neither is a security hole on its
// own, since every value is rendered as a plain text child, never
// `dangerouslySetInnerHTML` (§3) — this is defense in depth on top of
// that, not the only thing guarding it.
const URL_KEY_PATTERN = /image|photo|logo|^global\.social\./i;

function isSafeUrlValue(value: string): boolean {
  return value.startsWith("/") || value.startsWith("https://");
}

export function assertValueIsValid(key: string, value: string) {
  if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) {
    throw ApiError.badRequest(`Value for "${key}" exceeds the 16KB size limit`);
  }
  if (!URL_KEY_PATTERN.test(key)) return;

  const lines = value
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (!isSafeUrlValue(line)) {
      throw ApiError.badRequest(`Value for "${key}" must be a root-relative path ("/...") or an https:// URL`);
    }
  }
}
