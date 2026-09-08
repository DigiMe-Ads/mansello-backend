import { Request, Response } from "express";
import * as service from "./service";

// Public, on the critical path for every visitor (fetched once on app
// load) — kept fast and cacheable. See BACKEND_CHANGES_SITE_CONTENT.md §2:
// this must never 5xx on a partial read (there isn't one — it's a single
// unfiltered SELECT) and an empty array is a fully valid response, not an
// error, so ContentProvider's defaults-on-any-failure fallback never has a
// reason to trigger from this endpoint's own behavior.
export async function getContent(_req: Request, res: Response) {
  res.set("Cache-Control", "public, max-age=60");
  res.json(await service.listContent());
}

export async function putContent(req: Request, res: Response) {
  res.json(await service.upsertContent(req.body.entries, req.admin!.sub));
}

export async function deleteContent(req: Request, res: Response) {
  await service.deleteContent(req.body.keys);
  res.status(204).send();
}
