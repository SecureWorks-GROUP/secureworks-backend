-- The runner has just run the down migration against the forward stack (no pg_cron).
-- 1. The terms columns, their checks and the write path are gone; the 12:00 words are back;
--    the report and the settings row are untouched and report_auto_send is still off.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'debt_ws_settings'
                AND column_name IN ('company_terms', 'company_terms_default')) THEN
    RAISE EXCEPTION 'rollback contract: a company terms column is still on debt_ws_settings';
  END IF;
  IF to_regprocedure('public.debt_ws_set_company_terms(text, integer, text)') IS NOT NULL
     OR to_regprocedure('public.debt_ws_company_terms_valid(jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: a company terms function is still there';
  END IF;
  IF to_regprocedure('public.trigger_debt_ws_report_auto()') IS NULL
     OR to_regprocedure('public.trigger_debt_ws_report_refresh()') IS NULL
     OR to_regclass('public.debt_ws_reports') IS NULL THEN
    RAISE EXCEPTION 'rollback contract: the rollback removed the report itself';
  END IF;
  IF obj_description('public.trigger_debt_ws_report_auto()'::regprocedure, 'pg_proc')
       NOT LIKE '%Wed 12:00 Perth%'
     OR obj_description('public.trigger_debt_ws_report_refresh()'::regprocedure, 'pg_proc')
       NOT LIKE '%Wed 11:55 Perth%' THEN
    RAISE EXCEPTION 'rollback contract: the report triggers do not name 12:00 again';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.debt_ws_settings WHERE id = 1 AND NOT report_auto_send) THEN
    RAISE EXCEPTION 'rollback contract: the settings row changed';
  END IF;
END $$;

-- 2. Re-running the rollback is a no-op.
\ir ../../../rollbacks/20261105120000_debt_ws_receivables_down.sql

-- 3. The forward migration applies again cleanly after a rollback, with the seed.
BEGIN;
\ir ../../../migrations/20261105120000_debt_ws_receivables.sql
DO $$
BEGIN
  IF to_regprocedure('public.debt_ws_set_company_terms(text, integer, text)') IS NULL
     OR (SELECT company_terms ->> 'eb7bc4e3-d7c1-41a6-99e1-723452c6e497'
           FROM public.debt_ws_settings WHERE id = 1) IS DISTINCT FROM '14' THEN
    RAISE EXCEPTION 'rollback contract: the forward migration did not re-apply';
  END IF;
END $$;
ROLLBACK;
