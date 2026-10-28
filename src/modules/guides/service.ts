import type { Site } from "@prisma/client";
import { prisma } from "@/db/prisma";
import type { GuideContent } from "./validation";

// Accepts the URL spelling ("sri-lanka") as well as the enum's.
export function toSite(param: string): Site {
  return param === "italy" ? "italy" : "sri_lanka";
}

// `content: null` means "never edited" — the frontend shows its built-in
// default guide, so a fresh install needs no seeding.
export async function getGuide(site: Site) {
  const row = await prisma.guide.findUnique({ where: { site } });
  return { site, content: row?.content ?? null, updatedAt: row?.updatedAt ?? null };
}

export async function saveGuide(site: Site, content: GuideContent, updatedById: string) {
  const row = await prisma.guide.upsert({
    where: { site },
    update: { content, updatedById },
    create: { site, content, updatedById },
  });
  return { site, content: row.content, updatedAt: row.updatedAt };
}

// "Restore default" — removes the row so the built-in guide shows again.
export async function resetGuide(site: Site) {
  await prisma.guide.deleteMany({ where: { site } });
  return { site, content: null, updatedAt: null };
}
