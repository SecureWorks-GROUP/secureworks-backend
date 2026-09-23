-- MN1 setup. Earlier registered fixtures already supply every table MN1 reads:
-- context_capture_runs (F1, window_end_id from F1b), feature_flags (C1d, live
-- shape, no money flag rows, as in production) and xero_invoices (a reduced
-- stand-in, 20260911061500 and later). Add only the xero_invoices columns the
-- status block reads, in case a narrower fixture won the CREATE TABLE race.
ALTER TABLE public.xero_invoices
 ADD COLUMN IF NOT EXISTS job_id uuid,
 ADD COLUMN IF NOT EXISTS invoice_type text,
 ADD COLUMN IF NOT EXISTS status text,
 ADD COLUMN IF NOT EXISTS amount_due numeric;

-- Prove the fixtures leave exactly the pre-image the migration's guard pins.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_money_status()')) IS DISTINCT FROM '155104bfb08b8b3c2f98bdec089d4ee4'
 THEN RAISE EXCEPTION 'mn1 setup: context_money_status is not the production F1b stub'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.record_capture_run(jsonb)')) IS DISTINCT FROM 'db03c98a6da49f128595342f5a93f84c'
 THEN RAISE EXCEPTION 'mn1 setup: record_capture_run is not the production F1b body'; END IF;
 IF to_regprocedure('public.context_money_policy()') IS NOT NULL OR to_regprocedure('public.context_money_open_book_mode()') IS NOT NULL
 THEN RAISE EXCEPTION 'mn1 setup: a new function already exists'; END IF;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.xero_invoices'::regclass AND attname='xero_verified_at' AND NOT attisdropped)
 THEN RAISE EXCEPTION 'mn1 setup: xero_verified_at already exists'; END IF;
 IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name LIKE 'money_open_book%')
 THEN RAISE EXCEPTION 'mn1 setup: a money flag row already exists'; END IF;
END $$;
