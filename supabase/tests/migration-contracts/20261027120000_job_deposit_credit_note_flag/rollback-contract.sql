-- The runner has just run the down migration against the forward stack.
-- 1. The column is gone, the record and the two earlier reasons remain, the new one is refused.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'job_deposit_advance_state'
                AND column_name = 'counted_credit_note_ids') THEN
    RAISE EXCEPTION 'rollback contract: counted_credit_note_ids is still there';
  END IF;
  IF to_regclass('public.job_deposit_advance_state') IS NULL THEN
    RAISE EXCEPTION 'rollback contract: job_deposit_advance_state is gone';
  END IF;
END $$;
BEGIN;
INSERT INTO public.jobs (id, org_id, status, type, job_number)
VALUES ('00000000-0000-0000-0000-00000000d102', '00000000-0000-0000-0000-000000000001', 'order_materials', 'fencing', 'SWF-D102');
INSERT INTO public.job_deposit_advance_state (job_id, moved_at, flag)
VALUES ('00000000-0000-0000-0000-00000000d102', now(), 'deposit_unpaid');
DO $$
BEGIN
  BEGIN
    UPDATE public.job_deposit_advance_state SET flag = 'deposit_credited' WHERE job_id = '00000000-0000-0000-0000-00000000d102';
    RAISE EXCEPTION 'rollback contract: deposit_credited is still accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;

-- 2. Re-running the rollback is a no-op.
\ir ../../../rollbacks/20261027120000_job_deposit_credit_note_flag_down.sql

-- 3. The forward migration applies again cleanly after a rollback.
BEGIN;
\ir ../../../migrations/20261027120000_job_deposit_credit_note_flag.sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'job_deposit_advance_state'
                    AND column_name = 'counted_credit_note_ids') THEN
    RAISE EXCEPTION 'rollback contract: the forward migration did not re-apply';
  END IF;
END $$;
ROLLBACK;
