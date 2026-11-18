-- P1-10.1 prerequisites. Everything here already exists in the registered
-- stack (earlier cases); IF NOT EXISTS / to_regprocedure keep a standalone
-- run of this one case possible. No stand-in replaces a main object.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
-- P1-08.3's own prerequisites (tables, the hold and crew migrations).
\ir ../20261118063223_trade_pay_run_standing_checks/setup.sql
-- P1-01.1 column the approve function reads (on main since 20261117020000).
ALTER TABLE public.trade_pay_settings ADD COLUMN IF NOT EXISTS pay_run_approver_user_ids uuid[] NOT NULL DEFAULT '{}';
INSERT INTO public.trade_pay_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
-- P1-08.3 itself (the function the approval calls), registered as its own case.
SELECT to_regprocedure('public.trade_pay_run_standing_checks(uuid,uuid[],text)') IS NULL AS need_standing \gset
\if :need_standing
\ir ../../../migrations/20261118063223_trade_pay_run_standing_checks.sql
\endif
