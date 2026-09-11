BEGIN;

-- The shared fixture jobs table may carry NOT NULL columns from earlier cases
-- (org_id, type, status). Insert with whatever of those exist.
DO $$
DECLARE
  cols text := 'id, job_number';
  vals text := quote_literal('70000000-0000-4000-8000-000000000001') || ', ' || quote_literal('SWMS-261403');
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'org_id') THEN
    cols := cols || ', org_id'; vals := vals || ', ' || quote_literal('00000000-0000-4000-8000-000000000001');
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'type') THEN
    cols := cols || ', type'; vals := vals || ', ' || quote_literal('makesafe');
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'status') THEN
    cols := cols || ', status'; vals := vals || ', ' || quote_literal('scheduled');
  END IF;
  EXECUTE format('INSERT INTO public.jobs (%s) VALUES (%s)', cols, vals);
END $$;

-- 1. A make-safe report submission files exactly one pending run keyed by job, cycle and report id.
INSERT INTO public.job_events (id, job_id, event_type, detail_json) VALUES
  ('71000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'makesafe_report_submitted',
   '{"report_id":"71000000-0000-4000-8000-000000000001","attendance_cycle_id":"72000000-0000-4000-8000-000000000001","cycle_number":1}');
DO $$
DECLARE r public.ses_report_trigger_runs;
BEGIN
  SELECT * INTO r FROM public.ses_report_trigger_runs WHERE job_id = '70000000-0000-4000-8000-000000000001';
  IF r.state <> 'pending' OR r.attendance_cycle_id <> '72000000-0000-4000-8000-000000000001' OR r.cycle_number <> 1
     OR r.dedupe_key <> '70000000-0000-4000-8000-000000000001:72000000-0000-4000-8000-000000000001:report:71000000-0000-4000-8000-000000000001'
     OR r.source->>'kind' <> 'makesafe_report' THEN
    RAISE EXCEPTION 'contract: first submission did not file the expected pending run: %', row_to_json(r);
  END IF;
END $$;

-- 2. The same identity again (re-delivered event) is a duplicate, not a second run.
INSERT INTO public.job_events (id, job_id, event_type, detail_json) VALUES
  ('71000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000001', 'makesafe_report_submitted',
   '{"report_id":"71000000-0000-4000-8000-000000000001","attendance_cycle_id":"72000000-0000-4000-8000-000000000001","cycle_number":1}');
DO $$
DECLARE n integer; d integer;
BEGIN
  SELECT count(*), max(duplicate_events) INTO n, d FROM public.ses_report_trigger_runs WHERE job_id = '70000000-0000-4000-8000-000000000001';
  IF n <> 1 OR d <> 1 THEN RAISE EXCEPTION 'contract: duplicate event created a second run (rows=%, duplicates=%)', n, d; END IF;
END $$;

-- 3. An own-template roof submission keys on document id and render hash; unrelated events file nothing.
INSERT INTO public.job_events (id, job_id, event_type, detail_json) VALUES
  ('71000000-0000-4000-8000-000000000003', '70000000-0000-4000-8000-000000000001', 'roof_report_submitted',
   '{"report_doc_id":"73000000-0000-4000-8000-000000000001","render_hash":"abc123","draft_id":"74000000-0000-4000-8000-000000000001","report_type_job":true}'),
  ('71000000-0000-4000-8000-000000000004', '70000000-0000-4000-8000-000000000001', 'roof_report_saved', '{}');
DO $$
DECLARE n integer; k text;
BEGIN
  SELECT count(*) INTO n FROM public.ses_report_trigger_runs WHERE job_id = '70000000-0000-4000-8000-000000000001';
  IF n <> 2 THEN RAISE EXCEPTION 'contract: expected 2 runs after roof submission, got %', n; END IF;
  SELECT dedupe_key INTO k FROM public.ses_report_trigger_runs WHERE event_type = 'roof_report_submitted';
  IF k <> '70000000-0000-4000-8000-000000000001:cycle?:roof:73000000-0000-4000-8000-000000000001:abc123' THEN
    RAISE EXCEPTION 'contract: roof dedupe key wrong: %', k;
  END IF;
END $$;

-- 4. Claim is exclusive and bounded; a second claim of the same row returns nothing; a done row is never reclaimed.
DO $$
DECLARE r public.ses_report_trigger_runs; n integer; run uuid;
BEGIN
  SELECT id INTO run FROM public.ses_report_trigger_runs WHERE event_type = 'makesafe_report_submitted';
  SELECT * INTO r FROM public.claim_ses_report_trigger_run(run, 'contract-worker', 300);
  IF r.state <> 'claimed' OR r.attempts <> 1 OR r.claimed_by <> 'contract-worker' OR r.lease_expires_at IS NULL OR r.claim_token IS NULL THEN
    RAISE EXCEPTION 'contract: claim did not lease the row with a token: %', row_to_json(r);
  END IF;
  SELECT count(*) INTO n FROM public.claim_ses_report_trigger_run(run, 'second-worker', 300);
  IF n <> 0 THEN RAISE EXCEPTION 'contract: a live lease was reclaimed'; END IF;
  UPDATE public.ses_report_trigger_runs SET state = 'done', completed_at = clock_timestamp() WHERE id = run;
  SELECT count(*) INTO n FROM public.claim_ses_report_trigger_run(run, 'third-worker', 300);
  IF n <> 0 THEN RAISE EXCEPTION 'contract: a done run was reclaimed'; END IF;
  -- Next runnable is now the roof run.
  IF public.next_ses_report_trigger_run() <> (SELECT id FROM public.ses_report_trigger_runs WHERE event_type = 'roof_report_submitted') THEN
    RAISE EXCEPTION 'contract: next runnable row is not the pending roof run';
  END IF;
END $$;

-- 5. A failed run with a future next_attempt_at is not runnable; once due it is.
DO $$
DECLARE run uuid; n integer;
BEGIN
  SELECT id INTO run FROM public.ses_report_trigger_runs WHERE event_type = 'roof_report_submitted';
  UPDATE public.ses_report_trigger_runs SET state = 'failed', next_attempt_at = clock_timestamp() + interval '1 hour' WHERE id = run;
  IF public.next_ses_report_trigger_run() IS NOT NULL THEN RAISE EXCEPTION 'contract: backoff row was offered as runnable'; END IF;
  UPDATE public.ses_report_trigger_runs SET next_attempt_at = clock_timestamp() - interval '1 second' WHERE id = run;
  SELECT count(*) INTO n FROM public.claim_ses_report_trigger_run(run, 'retry-worker', 300);
  IF n <> 1 THEN RAISE EXCEPTION 'contract: due failed row could not be claimed'; END IF;
END $$;

-- 6. The attempt ceiling is enforced at claim time: a row already at six attempts is parked unknown, not re-run.
DO $$
DECLARE run uuid; n integer; st text;
BEGIN
  SELECT id INTO run FROM public.ses_report_trigger_runs WHERE event_type = 'roof_report_submitted';
  UPDATE public.ses_report_trigger_runs SET state = 'failed', attempts = 6, next_attempt_at = NULL WHERE id = run;
  SELECT count(*) INTO n FROM public.claim_ses_report_trigger_run(run, 'ceiling-worker', 600);
  SELECT state INTO st FROM public.ses_report_trigger_runs WHERE id = run;
  IF n <> 0 OR st <> 'unknown' THEN RAISE EXCEPTION 'contract: attempt ceiling did not park the row unknown (claimed=%, state=%)', n, st; END IF;
END $$;

-- 7. The ledger is server-owned: row level security on, browser roles hold no privilege.
DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ses_report_trigger_runs'::regclass) THEN
    RAISE EXCEPTION 'contract: row level security is not enabled on ses_report_trigger_runs';
  END IF;
  IF has_table_privilege('anon', 'public.ses_report_trigger_runs', 'SELECT') OR has_table_privilege('authenticated', 'public.ses_report_trigger_runs', 'UPDATE') THEN
    RAISE EXCEPTION 'contract: browser roles still hold privileges on ses_report_trigger_runs';
  END IF;
END $$;

-- 8. The drain is gated: with the cron gate false it performs no HTTP call and does not error.
SELECT public.trigger_ses_report_trigger_drain();

ROLLBACK;
