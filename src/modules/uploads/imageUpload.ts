import { randomUUID } from "crypto";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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

// Validates and stores the file, returning its object key.
async function putUploadedFile(
  file: Express.Multer.File,
  bucket: string,
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
      Bucket: bucket,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
    })
  );

  return key;
}

// Shared by every feature that uploads images (product catalog, offers,
// blog, ...) — one S3/R2 client, one set of rules. `folder` just organizes
// the bucket (products/, offers/, blog/, ...); callers don't need to agree
// on anything else. Public bucket: returns a permanent public URL.
export async function uploadImage(file: Express.Multer.File, folder = "uploads"): Promise<string> {
  const key = await putUploadedFile(file, env.s3.bucket, folder, IMAGE_EXTENSION_BY_MIME_TYPE, "JPEG, PNG, or WebP");
  return `${env.s3.publicUrl.replace(/\/$/, "")}/${key}`;
}

export const GUEST_DOCUMENTS_PREFIX = "guest-documents/";
const SIGNED_URL_SECONDS = 15 * 60;

// Guest-submitted documents (passport scans, PDFs) for one booking-info
// request. Stored in the PRIVATE bucket under guest-documents/<requestId>/,
// and only the object key is returned — never a URL. Admins view them via
// signDocumentUrl. See BACKEND_SECURITY_AUDIT.md H5.
export function uploadDocument(file: Express.Multer.File, requestId: string): Promise<string> {
  return putUploadedFile(
    file,
    env.s3.privateBucket,
    `${GUEST_DOCUMENTS_PREFIX}${requestId}`,
    DOCUMENT_EXTENSION_BY_MIME_TYPE,
    "JPEG, PNG, WebP, or PDF"
  );
}

// Short-lived link to a private document, for the admin panel (which
// re-fetches every 10 minutes while open, so links never go stale).
export function signDocumentUrl(key: string): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: env.s3.privateBucket, Key: key }), {
    expiresIn: SIGNED_URL_SECONDS,
  });
}
