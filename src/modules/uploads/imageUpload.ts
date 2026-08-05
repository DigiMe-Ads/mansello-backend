import { randomUUID } from "crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { env } from "@/config/env";
import { ApiError } from "@/utils/ApiError";

const s3 = new S3Client({
  region: env.s3.region,
  endpoint: env.s3.endpoint,
  forcePathStyle: true, // required for R2 (and most non-AWS S3-compatible providers)
  credentials: { accessKeyId: env.s3.accessKeyId, secretAccessKey: env.s3.secretAccessKey },
});

const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

// Shared by every feature that uploads images (product catalog, offers,
// blog, ...) — one S3/R2 client, one set of rules. `folder` just organizes
// the bucket (products/, offers/, blog/, ...); callers don't need to agree
// on anything else.
export async function uploadImage(file: Express.Multer.File, folder = "uploads"): Promise<string> {
  if (!env.s3.bucket || !env.s3.publicUrl || !env.s3.endpoint) {
    throw ApiError.badRequest("Image upload is not configured (missing S3_* env vars)");
  }

  const ext = EXTENSION_BY_MIME_TYPE[file.mimetype];
  if (!ext) {
    throw ApiError.badRequest(`Unsupported image type: ${file.mimetype}. Use JPEG, PNG, or WebP.`);
  }

  const key = `${folder}/${randomUUID()}.${ext}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: env.s3.bucket,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
    })
  );

  return `${env.s3.publicUrl.replace(/\/$/, "")}/${key}`;
}
