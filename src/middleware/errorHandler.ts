import { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { MulterError } from "multer";
import { Prisma } from "@prisma/client";
import { ApiError } from "@/utils/ApiError";

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof MulterError) {
    return res.status(400).json({ error: "upload_error", message: err.message });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "validation_error",
      message: "Request failed validation",
      details: err.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }

  if (err instanceof ApiError) {
    return res.status(err.status).json({
      error: err.message,
      // Same text again under `message`, the key the frontend shows to the
      // user (and what every other error shape here already uses).
      message: err.message,
      details: err.details,
    });
  }

  // Postgres exclusion-constraint violation surfaces via Prisma as code P2010 / raw 23P01
  if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "23P01") {
    return res.status(409).json({
      error: "date_conflict",
      message: "These dates are no longer available for this property.",
    });
  }

  // Prisma errors that are really the caller's fault, not a server fault —
  // an unknown id on update/delete, a duplicate unique value, a reference to
  // a row that doesn't exist, or a malformed value (e.g. ?status=bogus).
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "not_found", message: "That record doesn't exist (it may have been deleted)." });
    }
    if (err.code === "P2002") {
      const target = (err.meta?.target as string[] | string | undefined) ?? "value";
      const fields = Array.isArray(target) ? target.join(", ") : target;
      return res.status(409).json({ error: "conflict", message: `Another record already uses this ${fields}.` });
    }
    if (err.code === "P2003") {
      return res.status(400).json({ error: "bad_reference", message: "This refers to a record that doesn't exist." });
    }
  }
  if (err instanceof Prisma.PrismaClientValidationError) {
    return res.status(400).json({ error: "validation_error", message: "Request contains an invalid value." });
  }

  console.error(err);
  return res.status(500).json({ error: "internal_error", message: "Something went wrong" });
}
