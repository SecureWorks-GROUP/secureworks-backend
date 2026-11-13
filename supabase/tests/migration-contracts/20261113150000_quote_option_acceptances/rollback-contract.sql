-- The runner has just run the down migration against the forward stack.
-- 1. The write-once trigger is gone; the record is kept.
DO $$
BEGIN
  IF to_regprocedure('public.quote_option_acceptances_write_once()') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: the write-once function is still there';
  END IF;
  IF to_regclass('public.quote_option_acceptances') IS NULL THEN
    RAISE EXCEPTION 'rollback contract: the option record was dropped';
  END IF;
  IF to_regprocedure('public.accept_quote_document_with_options(uuid, timestamptz, jsonb)') IS NOT NULL
     OR to_regprocedure('public.apply_quote_options_to_scope_drafts(uuid, uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: an option function is still there';
  END IF;
  IF position('quote_option_stages' IN pg_get_functiondef('public.scope_payment_plan(uuid)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'rollback contract: scope_payment_plan was not restored';
  END IF;
  IF has_function_privilege('service_role', 'public.scope_payment_plan(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'rollback contract: scope_payment_plan became callable';
  END IF;
END $$;

-- 2. Re-running the rollback is a no-op.
\ir ../../../rollbacks/20261113150000_quote_option_acceptances_down.sql

-- 3. The forward migration applies again cleanly after a rollback.
BEGIN;
\ir ../../../migrations/20261113150000_quote_option_acceptances.sql
DO $$
BEGIN
  IF to_regprocedure('public.quote_option_acceptances_write_once()') IS NULL THEN
    RAISE EXCEPTION 'rollback contract: the forward migration did not re-apply';
  END IF;
  IF position('quote_option_stages' IN pg_get_functiondef('public.scope_payment_plan(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'rollback contract: the forward scope_payment_plan did not re-apply';
  END IF;
END $$;
ROLLBACK;
