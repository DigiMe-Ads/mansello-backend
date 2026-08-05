import { Request, Response } from "express";
import * as service from "./service";

// Same path serves the public storefront view and the admin panel's list —
// branch on req.admin (set by optionalAuth in routes.ts, never required).
export async function listPosts(req: Request, res: Response) {
  const { site } = req.query as { site?: "italy" | "sri_lanka" };
  const isAdmin = req.admin?.role === "super_admin";
  res.json(await service.listPosts({ site, includeDrafts: isAdmin }));
}

export async function getPostBySlug(req: Request, res: Response) {
  res.json(await service.getPublishedPostBySlug(req.params.slug));
}

export async function createPost(req: Request, res: Response) {
  const { publishedAt, ...rest } = req.body;
  res.status(201).json(
    await service.createPost({ ...rest, publishedAt: publishedAt ? new Date(publishedAt) : null })
  );
}

export async function updatePost(req: Request, res: Response) {
  const data = { ...req.body };
  if ("publishedAt" in data) {
    data.publishedAt = data.publishedAt ? new Date(data.publishedAt) : null;
  }
  res.json(await service.updatePost(req.params.id, data));
}

export async function deletePost(req: Request, res: Response) {
  await service.deletePost(req.params.id);
  res.status(204).send();
}
