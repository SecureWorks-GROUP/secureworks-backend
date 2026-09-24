-- The price book is self-contained: it needs only the API roles.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
END $$;
-- Earlier contracts may already have created this cluster-wide role without
-- Supabase's RLS bypass. Match the API role on both fresh and shared runners.
ALTER ROLE service_role BYPASSRLS;
