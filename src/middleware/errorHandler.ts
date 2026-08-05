import { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { MulterError } from "multer";
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

  console.error(err);
  return res.status(500).json({ error: "internal_error", message: "Something went wrong" });
}
