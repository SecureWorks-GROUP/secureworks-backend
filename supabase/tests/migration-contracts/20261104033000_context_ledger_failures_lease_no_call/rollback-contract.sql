-- After the undo every lapsed lease counts again, with or without a model call, and the definition is the old one.
BEGIN;
DO $$
DECLARE j uuid := gen_random_uuid(); f record;
BEGIN
 IF md5(pg_get_functiondef('public.context_ledger_failures(uuid[])'::regprocedure)) IS NULL
  OR pg_get_functiondef('public.context_ledger_failures(uuid[])'::regprocedure) LIKE '%context_model_call_reservations%' THEN
  RAISE EXCEPTION 'notes backoff rollback: the no-call rule is still there';
 END IF;
 INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, site_suburb, metadata, created_at)
 VALUES (j, '00000000-0000-0000-0000-000000000001', 'scheduled', 'fencing', 'SWF-91049', 'Fixture rollback', 'Testville', '{}', '2026-09-01');
 INSERT INTO public.context_extraction_runs (job_id, run_date, phase, status, error, started_at, finished_at, lease_token, run_seq)
 VALUES (j, '2026-11-03', 'ledger', 'failed', 'lease_expired', '2026-11-03 05:24:40+00', '2026-11-03 07:55:52+00', gen_random_uuid(), 1);
 SELECT * INTO f FROM public.context_ledger_failures(ARRAY[j]);
 IF f.failures <> 1 OR f.backoff_until <> '2026-11-03 09:55:52+00' THEN
  RAISE EXCEPTION 'notes backoff rollback: a lapsed lease no longer counts (% %)', f.failures, f.backoff_until;
 END IF;
END $$;
ROLLBACK;
