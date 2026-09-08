-- BACKEND_CHANGES_SEO_SECURITY_HARDENING.md §6.6: real session revocation
-- for POST /api/admin/logout. See the AdminUser.tokenVersion comment in
-- schema.prisma for how this is used.

-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN     "tokenVersion" INTEGER NOT NULL DEFAULT 0;
