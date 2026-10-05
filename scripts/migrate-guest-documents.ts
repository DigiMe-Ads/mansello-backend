// One-off (BACKEND_SECURITY_AUDIT.md H5): moves guest documents uploaded
// before the private bucket existed out of the PUBLIC image bucket.
//
// For every booking-info answer that is a public URL under guest-documents/:
//   1. copy the object into the private bucket as guest-documents/<requestId>/<file>
//   2. replace the answer with that key (the admin panel then gets signed URLs)
//   3. delete the public copy
// Then lists any guest-documents/ objects still left in the public bucket.
//
// Run AFTER the backend that reads keys is deployed:
//   npx tsx --tsconfig tsconfig.json scripts/migrate-guest-documents.ts          (dry run)
//   npx tsx --tsconfig tsconfig.json scripts/migrate-guest-documents.ts --apply
// Safe to re-run: already-migrated answers are keys, not URLs, and are skipped.
import {
  S3Client,
  CopyObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { Prisma } from "@prisma/client";
import { prisma } from "@/db/prisma";
import { env } from "@/config/env";
import { GUEST_DOCUMENTS_PREFIX } from "@/modules/uploads/imageUpload";

const apply = process.argv.includes("--apply");
const s3 = new S3Client({
  region: env.s3.region,
  endpoint: env.s3.endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: env.s3.accessKeyId, secretAccessKey: env.s3.secretAccessKey },
});
const publicBase = `${env.s3.publicUrl.replace(/\/$/, "")}/`;

async function main() {
  const requests = await prisma.bookingInfoRequest.findMany({ select: { id: true, answers: true } });
  let moved = 0;

  for (const request of requests) {
    const answers = request.answers as Record<string, unknown> | null;
    if (!answers || typeof answers !== "object") continue;

    const next: Record<string, unknown> = {};
    const copied: string[] = []; // public keys, deleted once the answers point at the private copies
    for (const [fieldId, value] of Object.entries(answers)) {
      if (!Array.isArray(value)) {
        next[fieldId] = value;
        continue;
      }
      const items: unknown[] = [];
      for (const item of value) {
        if (typeof item !== "string" || !item.startsWith(publicBase + GUEST_DOCUMENTS_PREFIX)) {
          items.push(item);
          continue;
        }
        const oldKey = item.slice(publicBase.length);
        const newKey = `${GUEST_DOCUMENTS_PREFIX}${request.id}/${oldKey.split("/").pop()}`;
        console.log(`${apply ? "MOVE" : "would move"}  ${oldKey}  ->  private:${newKey}`);
        if (apply) {
          await s3.send(
            new CopyObjectCommand({
              Bucket: env.s3.privateBucket,
              Key: newKey,
              CopySource: `${env.s3.bucket}/${oldKey}`,
            })
          );
        }
        items.push(newKey);
        copied.push(oldKey);
      }
      next[fieldId] = items;
    }

    if (copied.length === 0) continue;
    moved += copied.length;
    if (!apply) continue;

    // Answers first, public copies second: if a delete fails, the document is
    // still served to the admin from the private copy, and a re-run of the
    // leftover listing below shows what to remove by hand.
    await prisma.bookingInfoRequest.update({
      where: { id: request.id },
      data: { answers: next as Prisma.InputJsonValue },
    });
    for (const key of copied) {
      await s3.send(new DeleteObjectCommand({ Bucket: env.s3.bucket, Key: key }));
    }
  }

  const leftover = await s3.send(
    new ListObjectsV2Command({ Bucket: env.s3.bucket, Prefix: GUEST_DOCUMENTS_PREFIX })
  );
  console.log(`\n${apply ? "Moved" : "Would move"} ${moved} document(s).`);
  console.log(
    `Still in the public bucket under ${GUEST_DOCUMENTS_PREFIX}: ${leftover.KeyCount ?? 0}` +
      (leftover.Contents?.length ? `\n  ${leftover.Contents.map((o) => o.Key).join("\n  ")}` : "")
  );
  if (!apply) console.log("\nDry run — re-run with --apply to perform it.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
