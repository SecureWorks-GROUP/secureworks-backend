-- Prerequisites for 20261020170100_job_client_signoffs: jobs, job_media, feature_flags and the API
-- roles, all created by earlier registered setups (checked here).
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.jobs', 'public.job_media', 'public.feature_flags'] LOOP
  IF to_regclass(t) IS NULL THEN RAISE EXCEPTION 'client signoff setup: % missing from the registered stack', t; END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = t) THEN
   RAISE EXCEPTION 'client signoff setup: role % missing from the registered stack', t;
  END IF;
 END LOOP;
END $$;

-- Supabase gives anon, authenticated and service_role ALL on every new table in
-- public through default privileges. Mirror that here so the contract's
-- privilege checks prove the migration's REVOKEs, not the harness's defaults.
-- Default privileges belong to this database, which every phase recreates.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
