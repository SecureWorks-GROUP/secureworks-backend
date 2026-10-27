-- Contract for 20261026160000_job_deposit_advance.sql. Every fixture write is inside a
-- transaction that rolls back.

-- 1. The switch ships off and is a closed list; the other switches are untouched.
DO $$
BEGIN
  IF (SELECT deposit_advance_mode FROM public.job_closeout_settings WHERE id = 1) <> 'off' THEN
    RAISE EXCEPTION 'deposit advance contract: the switch must ship off';
  END IF;
  IF (SELECT get_review_move_enabled FROM public.job_closeout_settings WHERE id = 1) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'deposit advance contract: the close-out switch changed';
  END IF;
  BEGIN
    UPDATE public.job_closeout_settings SET deposit_advance_mode = 'loud' WHERE id = 1;
    RAISE EXCEPTION 'deposit advance contract: an unknown mode was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- 2. The record: one row per job, closed text and flag lists, service role only.
DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.job_deposit_advance_state'::regclass) THEN
    RAISE EXCEPTION 'deposit advance contract: job_deposit_advance_state requires row-level security';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_deposit_advance_state') <> 1
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_deposit_advance_state'
                 AND NOT (roles = ARRAY['service_role']::name[])) THEN
    RAISE EXCEPTION 'deposit advance contract: job_deposit_advance_state must carry exactly one service-role policy';
  END IF;
  IF has_table_privilege('anon', 'public.job_deposit_advance_state', 'SELECT')
     OR has_table_privilege('authenticated', 'public.job_deposit_advance_state', 'SELECT') THEN
    RAISE EXCEPTION 'deposit advance contract: anon or authenticated can read job_deposit_advance_state';
  END IF;
END $$;

BEGIN;
INSERT INTO public.jobs (id, org_id, status, type, job_number)
VALUES ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-000000000001', 'order_materials', 'fencing', 'SWF-D001');
INSERT INTO public.job_deposit_advance_state (job_id, moved_at, moved_to, counted_invoice_ids)
VALUES ('00000000-0000-0000-0000-00000000d001', now(), 'order_materials', ARRAY['inv-1']);
DO $$
BEGIN
  BEGIN
    INSERT INTO public.job_deposit_advance_state (job_id) VALUES ('00000000-0000-0000-0000-00000000d001');
    RAISE EXCEPTION 'deposit advance contract: a second record for one job was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.job_deposit_advance_state SET text_status = 'maybe' WHERE job_id = '00000000-0000-0000-0000-00000000d001';
    RAISE EXCEPTION 'deposit advance contract: an unknown text status was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.job_deposit_advance_state SET flag = 'moved_back' WHERE job_id = '00000000-0000-0000-0000-00000000d001';
    RAISE EXCEPTION 'deposit advance contract: an unknown flag was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
-- The once-only claim: only one conditional update finds a row with no text status.
UPDATE public.job_deposit_advance_state SET text_status = 'claimed'
 WHERE job_id = '00000000-0000-0000-0000-00000000d001' AND text_status IS NULL;
DO $$
DECLARE
  v_rows integer;
BEGIN
  UPDATE public.job_deposit_advance_state SET text_status = 'claimed'
   WHERE job_id = '00000000-0000-0000-0000-00000000d001' AND text_status IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'deposit advance contract: the text claim was taken twice';
  END IF;
END $$;
ROLLBACK;

-- 3. Re-applying the migration is a no-op and keeps the operator's switch.
BEGIN;
UPDATE public.job_closeout_settings SET deposit_advance_mode = 'live' WHERE id = 1;
\ir ../../../migrations/20261026160000_job_deposit_advance.sql
DO $$
BEGIN
  IF (SELECT deposit_advance_mode FROM public.job_closeout_settings WHERE id = 1) <> 'live' THEN
    RAISE EXCEPTION 'deposit advance contract: re-applying changed the switch';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_deposit_advance_state') <> 1 THEN
    RAISE EXCEPTION 'deposit advance contract: re-applying changed the policies';
  END IF;
END $$;
ROLLBACK;
