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

const IMAGE_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

// Same allow-list as images, plus PDF — guest-submitted documents (e.g. a
// passport scan) are the one caller so far that needs this.
const DOCUMENT_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  ...IMAGE_EXTENSION_BY_MIME_TYPE,
  "application/pdf": "pdf",
};

// The frontend's `accept="image/jpeg,image/png,image/webp"` is a file-picker
// filter, not validation — drag-and-drop bypasses it, and `file.mimetype`
// itself is just whatever Content-Type the client's multipart request
// happened to declare, not a fact about the actual bytes. This sniffs the
// first few bytes against each allowed type's real magic number instead —
// see BACKEND_CHANGES_SEO_SECURITY_HARDENING.md §6.5. Deliberately hand-rolled
// (4 fixed signatures) rather than pulling in a file-type-sniffing
// dependency for this alone.
function sniffMimeType(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  )
    return "image/png";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP")
    return "image/webp";
  if (buf.length >= 5 && buf.toString("ascii", 0, 5) === "%PDF-") return "application/pdf";
  return null;
}

async function putUploadedFile(
  file: Express.Multer.File,
  folder: string,
  extensionByMimeType: Record<string, string>,
  allowedTypesLabel: string
): Promise<string> {
  if (!env.s3.bucket || !env.s3.publicUrl || !env.s3.endpoint) {
    throw ApiError.badRequest("Upload is not configured (missing S3_* env vars)");
  }

  const ext = extensionByMimeType[file.mimetype];
  if (!ext) {
    throw ApiError.badRequest(`Unsupported file type: ${file.mimetype}. Use ${allowedTypesLabel}.`);
  }

  const sniffed = sniffMimeType(file.buffer);
  if (!sniffed || !(sniffed in extensionByMimeType) || sniffed !== file.mimetype) {
    throw ApiError.badRequest(
      `File content doesn't match its declared type (${file.mimetype}). Use ${allowedTypesLabel}.`
    );
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

// Shared by every feature that uploads images (product catalog, offers,
// blog, ...) — one S3/R2 client, one set of rules. `folder` just organizes
// the bucket (products/, offers/, blog/, ...); callers don't need to agree
// on anything else.
export function uploadImage(file: Express.Multer.File, folder = "uploads"): Promise<string> {
  return putUploadedFile(file, folder, IMAGE_EXTENSION_BY_MIME_TYPE, "JPEG, PNG, or WebP");
}

// Same bucket/client as uploadImage, own path prefix and a wider allow-list
// (adds PDF) — used by the guest-facing booking-info form's "file" field
// type, where a guest might be uploading a passport scan or a PDF.
export function uploadDocument(file: Express.Multer.File, folder = "guest-documents"): Promise<string> {
  return putUploadedFile(file, folder, DOCUMENT_EXTENSION_BY_MIME_TYPE, "JPEG, PNG, WebP, or PDF");
}
