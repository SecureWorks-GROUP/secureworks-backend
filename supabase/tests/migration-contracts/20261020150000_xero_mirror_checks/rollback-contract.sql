-- The runner has just run the down migration against the forward stack.
-- 1. The table is gone.
DO $$
BEGIN
  IF to_regclass('public.xero_mirror_checks') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: xero_mirror_checks is still there';
  END IF;
END $$;

-- 2. Re-running the rollback is a no-op.
\ir ../../../rollbacks/20261020150000_xero_mirror_checks_down.sql

-- 3. The forward migration applies again cleanly after a rollback.
BEGIN;
\ir ../../../migrations/20261020150000_xero_mirror_checks.sql
DO $$
BEGIN
  IF to_regclass('public.xero_mirror_checks') IS NULL THEN
    RAISE EXCEPTION 'rollback contract: the forward migration did not re-apply';
  END IF;
END $$;
ROLLBACK;
