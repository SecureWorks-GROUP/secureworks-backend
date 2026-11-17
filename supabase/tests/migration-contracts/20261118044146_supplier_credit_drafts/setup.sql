-- Table-only prerequisites for this isolated case. No function stand-ins.
DO $setup$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
END $setup$;
CREATE TABLE IF NOT EXISTS public.feature_flags (
  flag_name text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false, description text
);
