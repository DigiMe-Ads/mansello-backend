import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "@/db/prisma";
import { env } from "@/config/env";
import { ApiError } from "@/utils/ApiError";
import { AdminJwtPayload } from "@/middleware/auth";

function signTokens(payload: AdminJwtPayload) {
  const accessToken = jwt.sign(payload, env.jwtAccessSecret, {
    expiresIn: env.jwtAccessExpiresIn as jwt.SignOptions["expiresIn"],
  });
  const refreshToken = jwt.sign(payload, env.jwtRefreshSecret, {
    expiresIn: env.jwtRefreshExpiresIn as jwt.SignOptions["expiresIn"],
  });
  return { accessToken, refreshToken };
}

export async function login(email: string, password: string) {
  const admin = await prisma.adminUser.findUnique({ where: { email } });
  if (!admin) throw ApiError.unauthorized("Invalid email or password");

  const valid = await bcrypt.compare(password, admin.passwordHash);
  if (!valid) throw ApiError.unauthorized("Invalid email or password");

  const payload: AdminJwtPayload = {
    sub: admin.id,
    role: admin.role,
    propertyScopeId: admin.propertyScopeId,
  };
  return { admin: { id: admin.id, email: admin.email, role: admin.role }, ...signTokens(payload) };
}

export function refresh(refreshToken: string) {
  try {
    const payload = jwt.verify(refreshToken, env.jwtRefreshSecret) as AdminJwtPayload;
    return signTokens({ sub: payload.sub, role: payload.role, propertyScopeId: payload.propertyScopeId });
  } catch {
    throw ApiError.unauthorized("Invalid or expired refresh token");
  }
}

export async function getDashboard() {
  const now = new Date();
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const [upcomingCheckIns, upcomingCheckOuts, revenueByProperty, lowStockCount, pendingOrders] =
    await Promise.all([
      prisma.booking.findMany({
        where: { checkIn: { gte: now, lte: in7Days }, status: { in: ["confirmed", "paid_offline"] } },
        include: { property: true },
        orderBy: { checkIn: "asc" },
      }),
      prisma.booking.findMany({
        where: { checkOut: { gte: now, lte: in7Days }, status: { in: ["confirmed", "paid_offline"] } },
        include: { property: true },
        orderBy: { checkOut: "asc" },
      }),
      prisma.booking.groupBy({
        by: ["propertyId"],
        where: { status: { in: ["confirmed", "paid_offline", "completed"] } },
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
    lowStockCount: Number(lowStockCount[0]?.count ?? 0),
    pendingOrdersCount: pendingOrders,
  };
}

// Called from a seed script / by a super_admin only — not a public signup route.
export async function createAdminUser(input: {
  email: string;
  password: string;
  role: "super_admin" | "villa_manager" | "marketplace_manager";
  propertyScopeId?: string;
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
