import { z } from "zod";

export const createAdminUserSchema = z.object({
  body: z
    .object({
      email: z.string().trim().email().max(254),
      password: z.string().min(10, "Password must be at least 10 characters").max(200),
      role: z.enum(["super_admin", "villa_manager", "marketplace_manager"]),
      propertyScopeId: z.string().uuid().nullable().optional(),
    })
    .refine((b) => b.role !== "villa_manager" || !!b.propertyScopeId, {
      message: "A villa manager must be scoped to a property",
      path: ["propertyScopeId"],
    }),
});
