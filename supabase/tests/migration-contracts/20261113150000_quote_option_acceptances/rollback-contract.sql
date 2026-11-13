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
END $$;
ROLLBACK;
