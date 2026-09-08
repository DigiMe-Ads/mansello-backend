import { prisma } from "@/db/prisma";
import { assertValueIsValid } from "./validation";

// Only rows that exist — never fabricate a default for an absent key. That
// distinction is the whole mechanism: an absent key means "use the
// frontend's built-in default", and an empty array is a valid, expected
// response for a fresh install. See BACKEND_CHANGES_SITE_CONTENT.md §1.
export function listContent() {
  return prisma.siteContent.findMany({ select: { key: true, value: true } });
}

// Upsert — only the keys sent are touched, every other key is left alone.
export async function upsertContent(entries: { key: string; value: string }[], updatedById: string) {
  for (const entry of entries) assertValueIsValid(entry.key, entry.value);

  await prisma.$transaction(
    entries.map((entry) =>
      prisma.siteContent.upsert({
        where: { key: entry.key },
        update: { value: entry.value, updatedById },
        create: { key: entry.key, value: entry.value, updatedById },
      })
    )
  );

  return prisma.siteContent.findMany({
    where: { key: { in: entries.map((e) => e.key) } },
    select: { key: true, value: true },
  });
}

// Removes keys so the site falls back to its built-in defaults. Not
// currently called by the admin UI ("Restore Defaults" writes the default
// values explicitly instead — see the doc) but worth having for cleanup.
export async function deleteContent(keys: string[]) {
  await prisma.siteContent.deleteMany({ where: { key: { in: keys } } });
}
