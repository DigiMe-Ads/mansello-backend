-- BACKEND_SECURITY_AUDIT.md / BACKEND_CHANGES_SECURITY_AUDIT_FRONTEND.md

-- C1: Supabase exposes the `public` schema over its REST API to the `anon`
-- and `authenticated` roles. This app never uses that API — every read goes
-- through the backend, which connects as the table owner and therefore
-- bypasses RLS. Enable RLS with NO policies (deny-all for everyone else)
-- and drop those roles' grants, including on tables created later. Guarded
-- so it's a no-op on a plain (non-Supabase) Postgres without those roles.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
  END IF;
END $$;

-- M2: the contact form already sends this subject; it used to 500.
-- AlterEnum
ALTER TYPE "ContactSubject" ADD VALUE 'tour_package';

-- H3: record the outcome of the Stripe refund that follows a cancellation.
-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "refundError" TEXT,
ADD COLUMN     "stripeRefundId" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "refundError" TEXT,
ADD COLUMN     "stripeRefundId" TEXT;
