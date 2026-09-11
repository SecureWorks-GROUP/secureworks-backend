-- Minimal pre-migration surface for the SES report drain flag contract.
-- 20260911060000_ses_report_trigger_runs (registered earlier) already created
-- the run ledger, the drain and its fixtures. This file only restates the
-- fixtures the drain needs so the case stands on its own, idempotently and
-- without changing any shape an earlier case relies on.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- Mirrors the production make-safe email-polling gate in its default state
-- (makesafe_cron_settings.cron_enabled = false), which is the incident state.
CREATE OR REPLACE FUNCTION public.makesafe_cron_enabled() RETURNS boolean
  LANGUAGE sql AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.sw_service_key() RETURNS text
  LANGUAGE sql AS $$ SELECT 'contract-fixture-key' $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;
