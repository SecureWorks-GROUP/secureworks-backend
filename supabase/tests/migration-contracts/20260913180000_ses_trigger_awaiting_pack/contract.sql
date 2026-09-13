BEGIN;

DO $$
DECLARE
  cols text := 'id, job_number';
  vals text := quote_literal('80000000-0000-4000-8000-000000000001') || ', ' || quote_literal('SWMS-261403');
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

INSERT INTO public.ses_report_trigger_runs (
  id, dedupe_key, job_id, attendance_cycle_id, event_type, source, state, attempts, docket_revision_id
) VALUES
  (
    '81000000-0000-4000-8000-000000000001',
    '80000000-0000-4000-8000-000000000001:82000000-0000-4000-8000-000000000001:report:r1',
    '80000000-0000-4000-8000-000000000001',
    '82000000-0000-4000-8000-000000000001',
    'makesafe_report_submitted',
    '{"kind":"makesafe_report"}'::jsonb,
    'awaiting_pack',
    1,
    '83000000-0000-4000-8000-000000000001'
  ),
  (
    '81000000-0000-4000-8000-000000000002',
    '80000000-0000-4000-8000-000000000001:82000000-0000-4000-8000-000000000001:report:r2',
    '80000000-0000-4000-8000-000000000001',
    '82000000-0000-4000-8000-000000000001',
    'manual',
    '{"kind":"manual"}'::jsonb,
    'pending',
    0,
    NULL
  );

-- 1. Drain next() must not pick awaiting_pack (no auto-bind).
DO $$
DECLARE nxt uuid;
BEGIN
  nxt := public.next_ses_report_trigger_run();
  IF nxt IS DISTINCT FROM '81000000-0000-4000-8000-000000000002'::uuid THEN
    RAISE EXCEPTION 'contract: drain next() must offer the pending row, not awaiting_pack (got %)', nxt;
  END IF;
END $$;

-- 2. Explicit run_id may claim awaiting_pack without incrementing attempts.
DO $$
DECLARE r public.ses_report_trigger_runs; n integer;
BEGIN
  SELECT * INTO r FROM public.claim_ses_report_trigger_run(
    '81000000-0000-4000-8000-000000000001'::uuid, 'board-watch', 300
  );
  IF r.state <> 'claimed' OR r.attempts <> 1 OR r.claimed_by <> 'board-watch' OR r.claim_token IS NULL THEN
    RAISE EXCEPTION 'contract: awaiting_pack claim must lease without incrementing attempts: %', row_to_json(r);
  END IF;
  SELECT count(*) INTO n FROM public.claim_ses_report_trigger_run(
    '81000000-0000-4000-8000-000000000001'::uuid, 'second-worker', 300
  );
  IF n <> 0 THEN RAISE EXCEPTION 'contract: a live awaiting_pack lease was reclaimed'; END IF;
END $$;

-- 3. After the awaiting_pack row is claimed, next() is still the pending row.
DO $$
DECLARE nxt uuid;
BEGIN
  nxt := public.next_ses_report_trigger_run();
  IF nxt IS DISTINCT FROM '81000000-0000-4000-8000-000000000002'::uuid THEN
    RAISE EXCEPTION 'contract: claimed awaiting_pack must not become drain-next (got %)', nxt;
  END IF;
END $$;

ROLLBACK;
