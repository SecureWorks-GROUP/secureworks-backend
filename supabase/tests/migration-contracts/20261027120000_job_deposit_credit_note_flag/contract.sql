-- Contract for 20261027120000_job_deposit_credit_note_flag.sql. Every fixture write is
-- inside a transaction that rolls back.

-- 1. The credit note snapshot column: present, never null, empty by default.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'job_deposit_advance_state'
                    AND column_name = 'counted_credit_note_ids' AND is_nullable = 'NO'
                    AND data_type = 'ARRAY') THEN
    RAISE EXCEPTION 'deposit credit note contract: counted_credit_note_ids is missing or nullable';
  END IF;
END $$;

-- 2. The flag list admits deposit_credited, keeps the two earlier reasons, refuses others.
BEGIN;
INSERT INTO public.jobs (id, org_id, status, type, job_number)
VALUES ('00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-000000000001', 'order_materials', 'fencing', 'SWF-D101');
INSERT INTO public.job_deposit_advance_state (job_id, moved_at, moved_to, counted_invoice_ids)
VALUES ('00000000-0000-0000-0000-00000000d101', now(), 'order_materials', ARRAY['inv-1']);
DO $$
BEGIN
  IF (SELECT counted_credit_note_ids FROM public.job_deposit_advance_state
       WHERE job_id = '00000000-0000-0000-0000-00000000d101') <> '{}'::text[] THEN
    RAISE EXCEPTION 'deposit credit note contract: counted_credit_note_ids does not default to empty';
  END IF;
  UPDATE public.job_deposit_advance_state SET flag = 'deposit_voided' WHERE job_id = '00000000-0000-0000-0000-00000000d101';
  UPDATE public.job_deposit_advance_state SET flag = 'deposit_unpaid' WHERE job_id = '00000000-0000-0000-0000-00000000d101';
  UPDATE public.job_deposit_advance_state
     SET flag = 'deposit_credited', counted_credit_note_ids = ARRAY['cn-1']
   WHERE job_id = '00000000-0000-0000-0000-00000000d101';
  BEGIN
    UPDATE public.job_deposit_advance_state SET flag = 'moved_back' WHERE job_id = '00000000-0000-0000-0000-00000000d101';
    RAISE EXCEPTION 'deposit credit note contract: an unknown flag was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- 3. Re-applying the migration is a no-op: the open credit note flag and its snapshot stay.
\ir ../../../migrations/20261027120000_job_deposit_credit_note_flag.sql
DO $$
BEGIN
  IF (SELECT flag FROM public.job_deposit_advance_state WHERE job_id = '00000000-0000-0000-0000-00000000d101') <> 'deposit_credited'
     OR (SELECT counted_credit_note_ids FROM public.job_deposit_advance_state
          WHERE job_id = '00000000-0000-0000-0000-00000000d101') <> ARRAY['cn-1']::text[] THEN
    RAISE EXCEPTION 'deposit credit note contract: re-applying changed a record';
  END IF;
  IF (SELECT count(*) FROM pg_constraint
       WHERE conrelid = 'public.job_deposit_advance_state'::regclass
         AND conname = 'job_deposit_advance_state_flag_check') <> 1 THEN
    RAISE EXCEPTION 'deposit credit note contract: re-applying left no single flag check';
  END IF;
END $$;
ROLLBACK;
