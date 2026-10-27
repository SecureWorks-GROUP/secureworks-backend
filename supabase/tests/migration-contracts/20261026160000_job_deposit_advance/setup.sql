-- Pre-migration surface for the deposit advance switch and record. The earlier registered
-- case 20261013150000_job_closeout_review_archive already prepares public.jobs (with
-- org_id, status, type and job_number) and its migration creates
-- public.job_closeout_settings, so this case needs nothing more than the roles.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;
