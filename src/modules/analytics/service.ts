import { prisma } from "@/db/prisma";

const MAX_EVENTS_PER_REQUEST = 50;
const VALID_DEVICES = new Set(["desktop", "tablet", "mobile"]);
const VALID_SITES = new Set(["italy", "sri_lanka"]);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type ClickDevice = "desktop" | "tablet" | "mobile";

interface SanitizedClickEvent {
  site: "italy" | "sri_lanka" | null;
  path: string;
  xPct: number;
  yPct: number;
  viewportWidth: number;
  device: ClickDevice;
  sessionId: string;
  targetSelector: string | null;
  occurredAt: Date;
}

// Deliberately lenient, not the usual zod `validate()` middleware — this is
// a public, unauthenticated, fire-and-forget beacon endpoint hit directly
// from real visitors' browsers. A malformed event is just a dropped data
// point, never something worth failing loudly over (see
// BACKEND_CHANGES_HEATMAP_ANALYTICS.md) — so this filters rather than
// throws, and the caller always responds 202 regardless of what survives.
function sanitizeEvent(raw: unknown): SanitizedClickEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;

  if (typeof e.path !== "string" || e.path.length === 0) return null;
  if (typeof e.xPct !== "number" || !Number.isFinite(e.xPct)) return null;
  if (typeof e.yPct !== "number" || !Number.isFinite(e.yPct)) return null;
  if (typeof e.viewportWidth !== "number" || !Number.isFinite(e.viewportWidth)) return null;
  if (typeof e.device !== "string" || !VALID_DEVICES.has(e.device)) return null;
  if (typeof e.sessionId !== "string" || e.sessionId.length === 0) return null;

  const occurredAt = typeof e.occurredAt === "string" ? new Date(e.occurredAt) : null;
  if (!occurredAt || Number.isNaN(occurredAt.getTime())) return null;

  const site = typeof e.site === "string" && VALID_SITES.has(e.site) ? (e.site as "italy" | "sri_lanka") : null;
  const targetSelector = typeof e.targetSelector === "string" ? e.targetSelector.slice(0, 512) : null;

  return {
    site,
    path: e.path.slice(0, 2048),
    // Never trust the client's own clamp alone.
    xPct: Math.min(1, Math.max(0, e.xPct)),
    yPct: Math.min(1, Math.max(0, e.yPct)),
    viewportWidth: Math.round(e.viewportWidth),
    device: e.device as ClickDevice,
    sessionId: e.sessionId.slice(0, 128),
    targetSelector,
    occurredAt,
  };
}

// Truncates (doesn't reject) an oversized batch, and silently drops any
// individual malformed event rather than failing the whole request.
// Returns how many rows actually got inserted, for logging only — never
// surfaced to the caller (see controller).
export async function recordClickEvents(rawEvents: unknown[]): Promise<number> {
  const truncated = rawEvents.slice(0, MAX_EVENTS_PER_REQUEST);
  const valid = truncated
    .map(sanitizeEvent)
    .filter((e): e is SanitizedClickEvent => e !== null);

  if (valid.length === 0) return 0;

  const result = await prisma.clickEvent.createMany({ data: valid });
  return result.count;
}

export interface HeatmapPoint {
  xPct: number;
  yPct: number;
  weight: number;
}

export interface HeatmapQuery {
  path: string;
  device?: ClickDevice; // undefined = all devices
  from: Date; // inclusive, start of day
  toExclusive: Date; // exclusive — start of the day *after* the requested end date
}

// Aggregates straight off ClickEvent at read time rather than a
// materialized rollup — traffic here doesn't warrant one yet (see the doc).
// Rounding to 2 decimal places buckets clicks into a 100×100 grid, which is
// exactly the resolution the frontend's canvas renderer expects.
export async function getHeatmapData(query: HeatmapQuery) {
  const { path, device, from, toExclusive } = query;

  const points = await prisma.$queryRaw<{ gx: number; gy: number; weight: bigint }[]>`
    SELECT
      ROUND(CAST("xPct" AS numeric), 2) AS gx,
      ROUND(CAST("yPct" AS numeric), 2) AS gy,
      COUNT(*) AS weight
    FROM "ClickEvent"
    WHERE "path" = ${path}
      AND "occurredAt" >= ${from} AND "occurredAt" < ${toExclusive}
      AND (${device ?? null}::text IS NULL OR "device"::text = ${device ?? null})
    GROUP BY gx, gy
    ORDER BY weight DESC
  `;

  const pageViewsResult = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(DISTINCT "sessionId") AS count
    FROM "ClickEvent"
    WHERE "path" = ${path}
      AND "occurredAt" >= ${from} AND "occurredAt" < ${toExclusive}
      AND (${device ?? null}::text IS NULL OR "device"::text = ${device ?? null})
  `;

  const mappedPoints: HeatmapPoint[] = points.map((p) => ({
    xPct: Number(p.gx),
    yPct: Number(p.gy),
    weight: Number(p.weight),
  }));
  // Summing the grouped weights equals the ungrouped row count exactly —
  // grouping doesn't drop rows — so this avoids a third query.
  const totalClicks = mappedPoints.reduce((sum, p) => sum + p.weight, 0);
  const totalPageViews = Number(pageViewsResult[0]?.count ?? 0);
  const maxWeight = mappedPoints.reduce((max, p) => Math.max(max, p.weight), 0);

  return { totalClicks, totalPageViews, maxWeight, points: mappedPoints };
}

export interface HeatmapPageInfo {
  site: "italy" | "sri_lanka" | null;
  path: string;
  label: string;
  clicks: number;
}

// Cosmetic hint for the admin page-picker dropdown (annotates it with click
// counts) — all-time, all-devices, every path ever seen, not just the
// frontend's currently-hardcoded list.
export async function listHeatmapPages(site?: "italy" | "sri_lanka"): Promise<HeatmapPageInfo[]> {
  const rows = site
    ? await prisma.$queryRaw<{ site: string | null; path: string; clicks: bigint }[]>`
        SELECT "site", "path", COUNT(*) AS clicks
        FROM "ClickEvent"
        WHERE "site" = ${site}::"Site"
        GROUP BY "site", "path"
        ORDER BY clicks DESC
      `
    : await prisma.$queryRaw<{ site: string | null; path: string; clicks: bigint }[]>`
        SELECT "site", "path", COUNT(*) AS clicks
        FROM "ClickEvent"
        GROUP BY "site", "path"
        ORDER BY clicks DESC
      `;

  return rows.map((r) => ({
    site: r.site as "italy" | "sri_lanka" | null,
    path: r.path,
    label: r.path,
    clicks: Number(r.clicks),
  }));
}

// Scheduled retention cleanup (src/jobs) — raw rows are only ever consumed
// in aggregate and can grow fast; nothing on the frontend assumes rows live
// longer than the date ranges it offers (max 90 days), so 180 gives
// headroom without keeping data indefinitely.
export async function deleteStaleClickEvents(retentionDays = 180): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * MS_PER_DAY);
  const result = await prisma.clickEvent.deleteMany({ where: { occurredAt: { lt: cutoff } } });
  return result.count;
}
