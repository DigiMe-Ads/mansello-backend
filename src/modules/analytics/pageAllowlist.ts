// Server-side counterpart to the frontend's KNOWN_PAGES allowlist
// (src/components/admin/heatmap/known-pages.ts on the frontend — not
// readable from here) — see BACKEND_CHANGES_SEO_SECURITY_HARDENING.md §1.
// The frontend's list is the source of truth for *which* static pages the
// admin heatmap can actually render; this is a server-side backstop so the
// public, unauthenticated ingest endpoint can't be used to store an
// arbitrary path (most importantly a guest's `/booking-info/<token>` link
// or a marketplace order id — see the incident this doc describes) even if
// the frontend's own filter is ever bypassed or falls out of sync.
//
// Deliberately pattern-based rather than an exact copy of the frontend's
// literal list — this file has no access to that list, and a slug pattern
// (e.g. destinations/tour packages) is far less likely to silently drift
// out of sync than a hand-copied array would be. The cost of a pattern
// being slightly too permissive here is just extra (harmless) heatmap rows
// for a path shape that turns out not to be a real page; the cost of it
// being too narrow is losing heatmap coverage for a real page — neither is
// a security problem. The DANGEROUS_PATTERNS check below is what actually
// carries the security weight, and does not depend on this list being
// exactly right.
const STATIC_PATH_PATTERNS: RegExp[] = [
  /^\/$/,
  /^\/(italy|sri-lanka)$/,
  /^\/(italy|sri-lanka)\/(about|contact|airbnb|privacy|terms)$/,
  /^\/sri-lanka\/transport$/,
  // Destination pages and tour packages are static, bundled-at-build-time
  // routes (confirmed by BACKEND_CHANGES_SEO_SECURITY_HARDENING.md §4 —
  // they're in sitemap.xml precisely because their data lives in the
  // bundle, unlike blog posts) — safe to pattern-match the slug shape
  // rather than needing the exact enumerated list.
  /^\/(italy|sri-lanka)\/destinations\/[a-z0-9-]{1,80}$/,
  /^\/sri-lanka\/transport\/packages\/[a-z0-9-]{1,80}$/,
  /^\/sri-lanka\/marketplace$/,
  /^\/sri-lanka\/marketplace\/cart$/,
  /^\/sri-lanka\/marketplace\/checkout$/,
];

// Explicitly named in BACKEND_CHANGES_SEO_SECURITY_HARDENING.md §1.3 as the
// minimum bar — checked first and unconditionally, independent of whether a
// path also happens to match something in STATIC_PATH_PATTERNS above.
const DANGEROUS_PATTERNS: RegExp[] = [
  /^\/booking-info\//,
  /^\/admin(\/|$)/,
  /^\/sri-lanka\/marketplace\/order\//,
];

const MAX_PATH_LENGTH = 200;

export function isAllowedHeatmapPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
  // `@` matters beyond general hygiene: heatmap-viewer.tsx builds an iframe
  // src as `${origin}${path}` — a path starting with something like
  // "@evil.com/x" would be parsed by the browser as host evil.com. `?`/`#`
  // could smuggle query/fragment data through what's supposed to be a bare
  // path; `\` is a known WHATWG-URL-parsing normalization gotcha. A `://`
  // scheme marker catches an absolute URL passed as "path".
  if (/[?#@\\]/.test(path) || path.includes("://")) return false;
  if (DANGEROUS_PATTERNS.some((p) => p.test(path))) return false;
  return STATIC_PATH_PATTERNS.some((p) => p.test(path));
}
