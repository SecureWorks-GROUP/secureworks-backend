-- The runner has just run the down migration against the forward stack.
-- 1. The record and the switch are gone; the other close-out switches remain.
DO $$
BEGIN
  IF to_regclass('public.job_deposit_advance_state') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: job_deposit_advance_state is still there';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'job_closeout_settings'
                AND column_name = 'deposit_advance_mode') THEN
    RAISE EXCEPTION 'rollback contract: deposit_advance_mode is still there';
  END IF;
  IF (SELECT review_sender_mode FROM public.job_closeout_settings WHERE id = 1) IS NULL THEN
    RAISE EXCEPTION 'rollback contract: the review switch is gone';
  END IF;
END $$;

-- 2. Re-running the rollback is a no-op.
\ir ../../../rollbacks/20261026160000_job_deposit_advance_down.sql

-- 3. The forward migration applies again cleanly after a rollback.
BEGIN;
\ir ../../../migrations/20261026160000_job_deposit_advance.sql
DO $$
BEGIN
  IF to_regclass('public.job_deposit_advance_state') IS NULL
     OR (SELECT deposit_advance_mode FROM public.job_closeout_settings WHERE id = 1) <> 'off' THEN
    RAISE EXCEPTION 'rollback contract: the forward migration did not re-apply';
  END IF;
END $$;
ROLLBACK;
