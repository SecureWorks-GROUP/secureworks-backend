-- Minimal pre-migration surface for the SES drain cron job status contract.
-- 20260911090000_ses_report_drain_own_flag (registered earlier) created the
-- settings table and ses_report_drain_cron_runs() this case also reads. The
-- pg_cron and pg_net stand-ins live inside contract.sql's transaction so they
-- roll back and never reach the no-pg_cron assertions of earlier cases.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;
