DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
END $$;

-- The shared test stack supplies this prerequisite. The standalone proof starts empty.
CREATE TABLE IF NOT EXISTS public.feature_flags (
  flag_name text PRIMARY KEY,
  enabled boolean NOT NULL,
  description text
);
