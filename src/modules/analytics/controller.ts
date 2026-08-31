import { Request, Response } from "express";
import { env } from "@/config/env";
import { ApiError } from "@/utils/ApiError";
import * as service from "./service";

// Soft abuse guard, not a hard security boundary — easily spoofed by a
// determined bot, but stops casual scrapers/direct-curl traffic. Reuses the
// same allowed-origins list CORS already enforces, rather than inventing a
// second list to keep in sync. Falls back to Referer's origin since
// sendBeacon/fetch don't always set Origin identically across browsers;
// missing both is treated as untrusted.
function isTrustedOrigin(req: Request): boolean {
  const origin = req.headers.origin ?? refererOrigin(req.headers.referer);
  return !!origin && env.corsOrigin.includes(origin);
}

function refererOrigin(referer: string | undefined): string | undefined {
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

// Public, unauthenticated, fire-and-forget beacon endpoint — never returns
// a 4xx/5xx the caller could observe (the client already swallows every
// failure silently, and there's nothing a real visitor's browser could do
// about an error here anyway). An untrusted origin or a DB error just means
// nothing gets recorded; the response is 202 either way. Waits for the
// insert before responding (fast — a handful of rows) rather than firing it
// off after responding, so there's no ambiguity about it actually landing.
export async function recordClickEvents(req: Request, res: Response) {
  if (isTrustedOrigin(req)) {
    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    try {
      await service.recordClickEvents(events);
    } catch (err) {
      console.error("Failed to record click events:", err);
    }
  }

  res.status(202).end();
}

const VALID_DEVICE_FILTERS = new Set(["all", "desktop", "tablet", "mobile"]);

export async function getHeatmapData(req: Request, res: Response) {
  const { path, device: deviceParam, from: fromParam, to: toParam } = req.query as {
    path?: string;
    device?: string;
    from?: string;
    to?: string;
  };
  if (!path) throw ApiError.badRequest("path is required");
  if (deviceParam && !VALID_DEVICE_FILTERS.has(deviceParam)) {
    throw ApiError.badRequest('device must be "all", "desktop", "tablet", or "mobile"');
  }

  const device = !deviceParam || deviceParam === "all" ? undefined : (deviceParam as service.ClickDevice);
  const from = fromParam ? new Date(fromParam) : new Date(0);
  // `to` is inclusive per the request, so the exclusive upper bound is the
  // start of the day *after* it.
  const toExclusive = toParam
    ? new Date(new Date(toParam).getTime() + 24 * 60 * 60 * 1000)
    : new Date();

  const data = await service.getHeatmapData({ path, device, from, toExclusive });

  res.json({
    site: null, // the frontend already knows which site it asked for; kept for symmetry with listHeatmapPages, not derived server-side from `path` here
    path,
    device: deviceParam ?? "all",
    from: fromParam ?? null,
    to: toParam ?? null,
    ...data,
  });
}

export async function listHeatmapPages(req: Request, res: Response) {
  const { site } = req.query as { site?: string };
  if (site !== undefined && site !== "italy" && site !== "sri_lanka") {
    throw ApiError.badRequest('site must be "italy" or "sri_lanka"');
  }
  res.json(await service.listHeatmapPages(site));
}
