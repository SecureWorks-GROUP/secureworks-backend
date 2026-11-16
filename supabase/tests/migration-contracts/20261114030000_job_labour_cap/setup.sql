-- Pre-migration surface for the labour cap. Earlier registered cases already
-- prepare public.jobs, public.users, public.scope_revisions, public.job_budgets
-- (20261113190000), public.trade_invoices / trade_invoice_lines and
-- v_trade_charge_resolved (20261015093000), the billed statuses
-- (20261012130000), owner_approval_authority (20261109040000) and
-- public.feature_flags. This case adds only the roles (idempotent) and refuses
-- to run without those prerequisites.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF to_regclass('public.job_budgets') IS NULL
     OR to_regclass('public.v_trade_charge_resolved') IS NULL
     OR to_regclass('public.work_order_settings') IS NULL
     OR to_regprocedure('public.owner_approval_authority(uuid)') IS NULL
     OR to_regprocedure('public.job_work_order_billed_invoice_statuses()') IS NULL THEN
    RAISE EXCEPTION 'labour cap setup: a prerequisite case did not run';
  END IF;
END $$;
