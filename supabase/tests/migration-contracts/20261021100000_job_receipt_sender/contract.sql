-- Contract for 20261021100000_job_receipt_sender.sql. Every fixture write is inside a
-- transaction that rolls back.

-- 1. The switch ships off with no start instant, and is a closed list.
DO $$
BEGIN
  IF (SELECT receipt_sender_mode FROM public.job_closeout_settings WHERE id = 1) <> 'off'
     OR (SELECT receipt_sender_mode_since FROM public.job_closeout_settings WHERE id = 1) IS NOT NULL THEN
    RAISE EXCEPTION 'receipt contract: the receipt switch must ship off with no start instant';
  END IF;
  BEGIN
    UPDATE public.job_closeout_settings SET receipt_sender_mode = 'loud' WHERE id = 1;
    RAISE EXCEPTION 'receipt contract: an unknown receipt mode was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- 2. The start instant is stamped on every mode change, kept on any other update, and
--    can never be set by hand.
BEGIN;
UPDATE public.job_closeout_settings SET receipt_sender_mode = 'dry_run' WHERE id = 1;
DO $$
BEGIN
  IF (SELECT receipt_sender_mode_since FROM public.job_closeout_settings WHERE id = 1) IS NULL THEN
    RAISE EXCEPTION 'receipt contract: a mode change did not stamp the start instant';
  END IF;
END $$;
UPDATE public.job_closeout_settings
   SET receipt_sender_mode_since = '2020-01-01T00:00:00Z', note = 'hand edit'
 WHERE id = 1;
DO $$
BEGIN
  IF (SELECT receipt_sender_mode_since FROM public.job_closeout_settings WHERE id = 1) < '2026-01-01T00:00:00Z' THEN
    RAISE EXCEPTION 'receipt contract: the start instant was set by hand';
  END IF;
END $$;
UPDATE public.job_closeout_settings SET review_sender_mode = 'dry_run' WHERE id = 1;
DO $$
BEGIN
  IF (SELECT receipt_sender_mode_since FROM public.job_closeout_settings WHERE id = 1) IS NULL THEN
    RAISE EXCEPTION 'receipt contract: another update cleared the start instant';
  END IF;
END $$;
ROLLBACK;

-- 3. The claims: one per Xero invoice, closed status list, service role only.
DO $$
DECLARE
  v_refused boolean := false;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.job_receipt_claims'::regclass) THEN
    RAISE EXCEPTION 'receipt contract: job_receipt_claims requires row-level security';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_receipt_claims') <> 1
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_receipt_claims'
                 AND NOT (roles = ARRAY['service_role']::name[])) THEN
    RAISE EXCEPTION 'receipt contract: job_receipt_claims must carry exactly one service-role policy';
  END IF;
  IF has_table_privilege('anon', 'public.job_receipt_claims', 'SELECT')
     OR has_table_privilege('authenticated', 'public.job_receipt_claims', 'SELECT') THEN
    RAISE EXCEPTION 'receipt contract: anon or authenticated can read job_receipt_claims';
  END IF;
END $$;

BEGIN;
INSERT INTO public.job_receipt_claims (xero_invoice_id, status, trigger) VALUES ('inv-1', 'claimed', 'contract');
DO $$
BEGIN
  BEGIN
    INSERT INTO public.job_receipt_claims (xero_invoice_id, status, trigger) VALUES ('inv-1', 'claimed', 'contract');
    RAISE EXCEPTION 'receipt contract: a second claim for one invoice was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.job_receipt_claims (xero_invoice_id, status, trigger) VALUES ('inv-2', 'maybe', 'contract');
    RAISE EXCEPTION 'receipt contract: an unknown claim status was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;

-- 4. Re-applying the migration is a no-op and keeps the operator's switch.
BEGIN;
UPDATE public.job_closeout_settings SET receipt_sender_mode = 'live' WHERE id = 1;
\ir ../../../migrations/20261021100000_job_receipt_sender.sql
DO $$
BEGIN
  IF (SELECT receipt_sender_mode FROM public.job_closeout_settings WHERE id = 1) <> 'live'
     OR (SELECT receipt_sender_mode_since FROM public.job_closeout_settings WHERE id = 1) IS NULL THEN
    RAISE EXCEPTION 'receipt contract: re-applying changed the switch';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_receipt_claims') <> 1 THEN
    RAISE EXCEPTION 'receipt contract: re-applying changed the policies';
  END IF;
END $$;
ROLLBACK;
