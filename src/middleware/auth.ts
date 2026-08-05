import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "@/config/env";
import { ApiError } from "@/utils/ApiError";

export type AdminRole = "super_admin" | "villa_manager" | "marketplace_manager";

export interface AdminJwtPayload {
  sub: string; // admin user id
  role: AdminRole;
  propertyScopeId: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: AdminJwtPayload;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw ApiError.unauthorized();

  const token = header.slice("Bearer ".length);
  try {
    req.admin = jwt.verify(token, env.jwtAccessSecret) as AdminJwtPayload;
    next();
  } catch {
    throw ApiError.unauthorized("Invalid or expired token");
  }
}

// Populates req.admin if a valid token is present, but never rejects the
// request — for routes serving both a public view and a richer admin view
// off the same path (e.g. blog listing: drafts included only for admins).
// An invalid/expired token is treated as anonymous rather than a 401, since
// public callers won't send one at all and a stale one shouldn't break the
// public view for them.
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return next();

  const token = header.slice("Bearer ".length);
  try {
    req.admin = jwt.verify(token, env.jwtAccessSecret) as AdminJwtPayload;
  } catch {
    // fall through as anonymous
  }
  next();
}

export function requireRole(...roles: AdminRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.admin) throw ApiError.unauthorized();
    if (!roles.includes(req.admin.role)) throw ApiError.forbidden();
    next();
  };
}

// For villa_manager: blocks cross-property access unless super_admin.
export function requirePropertyScope(propertyIdParam = "propertyId") {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.admin) throw ApiError.unauthorized();
    if (req.admin.role === "super_admin") return next();
    const propertyId = req.params[propertyIdParam] ?? req.body.propertyId;
    if (req.admin.role === "villa_manager" && req.admin.propertyScopeId === propertyId) return next();
    throw ApiError.forbidden("Not scoped to this property");
  };
}
