import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import jwt from "jsonwebtoken";
import { prisma } from "@/db/prisma";
import { env } from "@/config/env";
import { ApiError } from "@/utils/ApiError";
import { AdminJwtPayload, JWT_VERIFY_OPTIONS } from "@/middleware/auth";

function signTokens(payload: AdminJwtPayload) {
  const accessToken = jwt.sign(payload, env.jwtAccessSecret, {
    expiresIn: env.jwtAccessExpiresIn as jwt.SignOptions["expiresIn"],
  });
  const refreshToken = jwt.sign(payload, env.jwtRefreshSecret, {
    expiresIn: env.jwtRefreshExpiresIn as jwt.SignOptions["expiresIn"],
  });
  return { accessToken, refreshToken };
}

// Compared against when the email doesn't exist, so an unknown email takes
// as long as a wrong password — response timing no longer reveals which
// admin emails are real (BACKEND_SECURITY_AUDIT.md L2).
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 12);

export async function login(email: string, password: string) {
  const admin =
    typeof email === "string" ? await prisma.adminUser.findUnique({ where: { email } }) : null;
  const valid = await bcrypt.compare(
    typeof password === "string" ? password : "",
    admin?.passwordHash ?? DUMMY_HASH
  );
  if (!admin || !valid) throw ApiError.unauthorized("Invalid email or password");

  const payload: AdminJwtPayload = {
    sub: admin.id,
    role: admin.role,
    propertyScopeId: admin.propertyScopeId,
    tokenVersion: admin.tokenVersion,
  };
  return { admin: { id: admin.id, email: admin.email, role: admin.role }, ...signTokens(payload) };
}

// Now async and DB-backed (it wasn't before) — needs the admin's *current*
// tokenVersion to detect a logged-out session, which a pure JWT-signature
// check can't express on its own. See BACKEND_CHANGES_SEO_SECURITY_HARDENING.md §6.6.
export async function refresh(refreshToken: string) {
  let payload: AdminJwtPayload;
  try {
    payload = jwt.verify(refreshToken, env.jwtRefreshSecret, JWT_VERIFY_OPTIONS) as AdminJwtPayload;
  } catch {
    throw ApiError.unauthorized("Invalid or expired refresh token");
  }

  const admin = await prisma.adminUser.findUnique({ where: { id: payload.sub } });
  if (!admin || admin.tokenVersion !== payload.tokenVersion) {
    throw ApiError.unauthorized("Session has been signed out — please log in again");
  }

  return signTokens({
    sub: admin.id,
    role: admin.role,
    propertyScopeId: admin.propertyScopeId,
    tokenVersion: admin.tokenVersion,
  });
}

// Invalidates every refresh token issued before this call (they carry the
// old tokenVersion) — the closest thing to real "log out everywhere" this
// app has, short of moving off stateless JWTs entirely. Already-issued
// *access* tokens are unaffected and keep working for their own remaining
// ≤15min lifetime — see the tokenVersion schema comment for why that's a
// deliberate trade-off, not an oversight.
export async function logout(adminId: string) {
  await prisma.adminUser.update({ where: { id: adminId }, data: { tokenVersion: { increment: 1 } } });
}

// Scoped to what the caller may see (BACKEND_SECURITY_AUDIT.md M1): a villa
// manager sees only their own property's guests and revenue, a marketplace
// manager sees no booking data at all. Same response shape for everyone.
export async function getDashboard(admin: AdminJwtPayload) {
  const now = new Date();
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const bookingScope: Prisma.BookingWhereInput =
    admin.role === "super_admin"
      ? {}
      : admin.role === "villa_manager" && admin.propertyScopeId
        ? { propertyId: admin.propertyScopeId }
        : { id: { in: [] } };
  const seesMarketplace = admin.role === "super_admin" || admin.role === "marketplace_manager";

  const [upcomingCheckIns, upcomingCheckOuts, revenueByProperty, lowStockCount, pendingOrders] =
    await Promise.all([
      prisma.booking.findMany({
        where: { ...bookingScope, checkIn: { gte: now, lte: in7Days }, status: { in: ["confirmed", "paid_offline"] } },
        include: { property: true },
        orderBy: { checkIn: "asc" },
      }),
      prisma.booking.findMany({
        where: { ...bookingScope, checkOut: { gte: now, lte: in7Days }, status: { in: ["confirmed", "paid_offline"] } },
        include: { property: true },
        orderBy: { checkOut: "asc" },
      }),
      prisma.booking.groupBy({
        by: ["propertyId"],
        where: { ...bookingScope, status: { in: ["confirmed", "paid_offline", "completed"] } },
        _sum: { totalPrice: true },
      }),
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) as count FROM "StockLevel" WHERE "quantityOnHand" <= "lowStockThreshold"
      `,
      prisma.order.count({ where: { status: "pending" } }),
    ]);

  return {
    upcomingCheckIns,
    upcomingCheckOuts,
    revenueByProperty,
    lowStockCount: seesMarketplace ? Number(lowStockCount[0]?.count ?? 0) : 0,
    pendingOrdersCount: seesMarketplace ? pendingOrders : 0,
  };
}

// Called from a seed script / by a super_admin only — not a public signup route.
export async function createAdminUser(input: {
  email: string;
  password: string;
  role: "super_admin" | "villa_manager" | "marketplace_manager";
  propertyScopeId?: string | null;
}) {
  const passwordHash = await bcrypt.hash(input.password, 12);
  return prisma.adminUser.create({
    data: {
      email: input.email,
      passwordHash,
      role: input.role,
      propertyScopeId: input.propertyScopeId,
    },
    select: { id: true, email: true, role: true, propertyScopeId: true },
  });
}

export function listAdminUsers() {
  return prisma.adminUser.findMany({
    select: { id: true, email: true, role: true, propertyScopeId: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function deleteAdminUser(id: string) {
  const admin = await prisma.adminUser.findUnique({ where: { id } });
  if (!admin) throw ApiError.notFound("Admin user not found");
  await prisma.adminUser.delete({ where: { id } });
}
