-- The runner has just run the down migration against the forward stack.
-- 1. The claims, the trigger and both columns are gone; the review switches remain.
DO $$
BEGIN
  IF to_regclass('public.job_receipt_claims') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: job_receipt_claims is still there';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'job_closeout_settings'
                AND column_name IN ('receipt_sender_mode', 'receipt_sender_mode_since')) THEN
    RAISE EXCEPTION 'rollback contract: a receipt column is still there';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'job_closeout_settings_receipt_mode_since') THEN
    RAISE EXCEPTION 'rollback contract: the receipt trigger is still there';
  END IF;
  IF (SELECT review_sender_mode FROM public.job_closeout_settings WHERE id = 1) IS NULL THEN
    RAISE EXCEPTION 'rollback contract: the review switch is gone';
  END IF;
END $$;

-- 2. Re-running the rollback is a no-op.
\ir ../../../rollbacks/20261021100000_job_receipt_sender_down.sql

-- 3. The forward migration applies again cleanly after a rollback.
BEGIN;
\ir ../../../migrations/20261021100000_job_receipt_sender.sql
DO $$
BEGIN
  IF to_regclass('public.job_receipt_claims') IS NULL
     OR (SELECT receipt_sender_mode FROM public.job_closeout_settings WHERE id = 1) <> 'off' THEN
    RAISE EXCEPTION 'rollback contract: the forward migration did not re-apply';
  END IF;
END $$;
ROLLBACK;
