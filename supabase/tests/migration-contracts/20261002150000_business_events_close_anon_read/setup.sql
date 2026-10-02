-- Pre-migration state for 20261002150000_business_events_close_anon_read,
-- shaped like production on 2 Oct 2026 (read-only check): row level security
-- on, select_all for PUBLIC USING (true), anon and authenticated holding
-- every table privilege.
-- public.business_events and public.users already exist from earlier
-- registered cases.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
-- Supabase's service_role bypasses row level security; mirror that here
-- (earlier cases create it plain when they are first to need it).
ALTER ROLE service_role BYPASSRLS;

-- Supabase's auth.uid(): the signed-in user's id from the request JWT.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(coalesce(
    current_setting('request.jwt.claim.sub', true),
    current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
  ), '')::uuid
$$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

ALTER TABLE public.business_events
  ADD COLUMN IF NOT EXISTS event_type text,
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS entity_type text,
  ADD COLUMN IF NOT EXISTS entity_id text,
  ADD COLUMN IF NOT EXISTS body_preview text;

ALTER TABLE public.business_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS insert_only ON public.business_events;
DROP POLICY IF EXISTS select_all ON public.business_events;
DROP POLICY IF EXISTS "Allow scope decision inserts from tools" ON public.business_events;
CREATE POLICY insert_only ON public.business_events FOR INSERT WITH CHECK (true);
CREATE POLICY select_all ON public.business_events FOR SELECT USING (true);
CREATE POLICY "Allow scope decision inserts from tools" ON public.business_events
  FOR INSERT TO anon WITH CHECK (event_type = 'scope.decision');

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Production (2 Oct 2026 snapshot): anon and authenticated hold every table
-- privilege through Supabase's default privileges, TRUNCATE included.
GRANT ALL ON public.business_events TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.business_events TO service_role;
GRANT SELECT ON public.users TO authenticated, service_role;
-- Supabase grants sequence use to the API roles by default.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;

-- One person per role that matters to the read. Fixed ids; nothing else uses them.
-- trade_sees_all_jobs follows the 20260925040000 backfill rule so that case's
-- contract still holds over these extra rows.
INSERT INTO public.users (id, org_id, name, role, trade_sees_all_jobs) VALUES
  ('be000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000aa', 'BE admin', 'admin', true),
  ('be000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-0000000000aa', 'BE owner', 'owner', true),
  ('be000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-0000000000aa', 'BE ops manager', 'ops_manager', true),
  ('be000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-0000000000aa', 'BE sales', 'sales', false),
  ('be000000-0000-4000-8000-000000000005', 'e0000000-0000-4000-8000-0000000000aa', 'BE sales manager', 'sales_manager', false),
  ('be000000-0000-4000-8000-000000000006', 'e0000000-0000-4000-8000-0000000000aa', 'BE estimator', 'estimator', false),
  ('be000000-0000-4000-8000-000000000007', 'e0000000-0000-4000-8000-0000000000aa', 'BE lead installer', 'lead_installer', false),
  ('be000000-0000-4000-8000-000000000008', 'e0000000-0000-4000-8000-0000000000aa', 'BE crew', 'crew', false),
  ('be000000-0000-4000-8000-000000000009', 'e0000000-0000-4000-8000-0000000000aa', 'BE no role', NULL, false)
ON CONFLICT (id) DO NOTHING;
