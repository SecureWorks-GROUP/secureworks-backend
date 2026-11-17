BEGIN;
SET LOCAL session_replication_role = replica;
-- Every fixture and policy edit rolls back. Exercise the real cadence judge.
DELETE FROM public.automation_switches;
INSERT INTO public.automation_switches (id, all_stop, extraction, attribution, capture)
VALUES (1, false, true, false, false);
DELETE FROM public.context_extraction_event_receipts;
DELETE FROM public.context_catchup_reads;
-- Earlier cases roll their fixtures back, leaving dead index entries. Give
-- this plan fixture fresh storage, without forcing the planner or pinning names.
TRUNCATE public.context_catchup_jobs;
DELETE FROM public.context_model_call_reservations;
DELETE FROM public.context_extraction_runs;
DELETE FROM public.business_events;
TRUNCATE public.job_change_mark_events, public.job_change_marks_base,
  public.job_notes_marks_seen, public.job_page_marks_seen;
CREATE TEMP TABLE worker_due_policy AS SELECT public.context_cadence_policy() || jsonb_build_object(
  'live_since', now() - interval '10 days', 'quiet_min', 5, 'ceiling_min', 30,
  'cooldown_min', 15, 'morning_until', '00:00', 'status_only_after', '23:59:59',
  'runs_per_job_day', 4, 'inbound_extra_runs', 0) AS p;
DO $c$ BEGIN
  EXECUTE format('CREATE OR REPLACE FUNCTION public.context_cadence_policy() RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $p$ SELECT %L::jsonb $p$',
    (SELECT p FROM worker_due_policy));
END $c$;
CREATE TEMP TABLE worker_due_jobs (job_id uuid PRIMARY KEY, ordinal integer) ON COMMIT DROP;
INSERT INTO worker_due_jobs SELECT gen_random_uuid(), g FROM generate_series(1, 2000) g;
INSERT INTO public.jobs (id, org_id, type, status, job_number, created_at)
SELECT job_id, '00000000-0000-4000-8000-000000000001', 'fencing', 'accepted',
  'ZZTEST-FACTS-' || ordinal, now() - interval '30 days' FROM worker_due_jobs;
INSERT INTO public.job_change_mark_events (job_id, marked_at, source)
SELECT j.job_id, now() - interval '2 hours' + g * interval '1 second', 'status'
FROM worker_due_jobs j CROSS JOIN generate_series(1, 5) g;
-- Old live evidence is not due. It still occupies the candidate index.
INSERT INTO public.business_events (id, job_id, event_type, source, direction, attribution_status,
  occurred_at, context_captured_at, attributed_at, payload, metadata)
SELECT gen_random_uuid(), j.job_id, 'client.sms_in', 'worker_due_contract', 'inbound', 'direct',
  now() - interval '20 days', now() - interval '20 days', now() - interval '20 days',
  '{"body":"Synthetic evidence"}', '{"written_as":"service_role","capture_mode":"live"}'
FROM worker_due_jobs j CROSS JOIN generate_series(1, 5) g;
-- A large completed catch-up population proves the empty unfinished probe is indexed.
INSERT INTO public.context_catchup_jobs (job_id, job_number, priority, done_at, done_run_id)
SELECT job_id, 'ZZTEST-CATCHUP-' || ordinal, 1, now(), gen_random_uuid() FROM worker_due_jobs;
CREATE TEMP TABLE worker_due_target AS
SELECT max(job_id::text)::uuid AS job_id FROM worker_due_jobs;
CREATE TEMP TABLE worker_due_event (id uuid);
INSERT INTO worker_due_event VALUES (gen_random_uuid());
CREATE FUNCTION pg_temp.worker_facts_assert(label text, expected integer) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE actual integer; selected integer; old_state jsonb; state jsonb;
BEGIN
  actual := public.context_worker_facts_present();
  selected := CASE WHEN EXISTS (SELECT 1 FROM public.context_extraction_candidates(1)) THEN 1 ELSE 0 END;
  IF actual IS DISTINCT FROM expected OR actual IS DISTINCT FROM selected THEN
    RAISE EXCEPTION 'worker facts due: % expected %, helper %, selector %', label, expected, actual, selected;
  END IF;
  state := public.context_worker_state() - 'at';
  old_state := pg_temp.worker_facts_before_state() - 'at';
  IF (state #- '{due,facts}') IS DISTINCT FROM (old_state #- '{due,facts}') THEN
    RAISE EXCEPTION 'worker facts due: non-facts state changed (%)', label;
  END IF;
END $f$;
DO $c$
DECLARE before_state text; before_helper text;
BEGIN
  SELECT state_definition, helper_definition INTO before_state, before_helper FROM public.worker_facts_due_preimage;
  IF pg_get_functiondef('public.context_worker_state()'::regprocedure) IS DISTINCT FROM before_state THEN
    RAISE EXCEPTION 'worker facts due: state definition changed';
  END IF;
  EXECUTE replace(before_helper, 'public.context_worker_facts_present()', 'pg_temp.worker_facts_before()');
  EXECUTE replace(replace(before_state, 'public.context_worker_state()', 'pg_temp.worker_facts_before_state()'),
    'public.context_worker_facts_present()', 'pg_temp.worker_facts_before()');
  IF NOT has_function_privilege('service_role','public.context_worker_facts_present()','EXECUTE')
    OR has_function_privilege('anon','public.context_worker_facts_present()','EXECUTE')
    OR has_function_privilege('authenticated','public.context_worker_facts_present()','EXECUTE') THEN
    RAISE EXCEPTION 'worker facts due: helper permissions changed';
  END IF;
END $c$;
ANALYZE public.jobs;
ANALYZE public.business_events;
ANALYZE public.job_change_mark_events;
ANALYZE public.context_catchup_jobs;
SELECT pg_temp.worker_facts_assert('10000 marks across 2000 jobs, nothing due', 0);
CREATE TEMP TABLE worker_facts_plans (label text, plan text) ON COMMIT DROP;
CREATE FUNCTION pg_temp.worker_facts_plan(label text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE query text; line text; sample text[]; plan text := '';
BEGIN
  SELECT prosrc INTO query FROM pg_proc WHERE oid='public.context_worker_facts_present()'::regprocedure;
  FOR line IN EXECUTE 'EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ' || query LOOP
    plan := plan || line || E'\n';
  END LOOP;
  INSERT INTO worker_facts_plans VALUES (label, plan);
  IF plan !~ '(Index Scan|Index Only Scan|Bitmap Heap Scan)[^\n]* on (public[.])?business_events '
    OR plan !~ '(Index Scan|Index Only Scan|Bitmap Heap Scan)[^\n]* on (public[.])?context_catchup_jobs '
    OR plan LIKE '%Seq Scan on business_events%' OR plan LIKE '%Seq Scan on context_catchup_jobs%' THEN
    RAISE EXCEPTION 'worker facts due: probe not index served: %', plan;
  END IF;
  -- Under these empty, sparse and dense fixtures the existence probe reads at
  -- most one qualifying source row and calls the judge at most once. Do not
  -- pin index names or claim a bound for an arbitrary all-blocked unread pool.
  FOR sample IN SELECT regexp_matches(plan,
    'on (business_events|context_catchup_jobs|context_jobs_cadence) [^(]*\(actual rows=([0-9]+) loops=([0-9]+)\)', 'g') LOOP
    IF sample[2]::bigint * sample[3]::bigint > 1 THEN
      RAISE EXCEPTION 'worker facts due: probe read beyond first due row: %', plan;
    END IF;
  END LOOP;
END $f$;
SELECT pg_temp.worker_facts_plan('nothing due');
INSERT INTO public.business_events (id, job_id, event_type, source, direction, attribution_status,
  occurred_at, context_captured_at, attributed_at, payload, metadata)
SELECT e.id, j.job_id, 'client.sms_in', 'worker_due_contract', 'inbound', 'direct',
  now()-interval '2 hours', now()-interval '2 hours', now()-interval '2 hours',
  '{"body":"Synthetic new evidence"}', '{"written_as":"service_role","capture_mode":"live"}'
FROM worker_due_event e CROSS JOIN worker_due_target j;
ANALYZE public.business_events;
UPDATE public.business_events SET attribution_confidence=1;
SELECT pg_temp.worker_facts_assert('one due job at the end of index order', 1);
SELECT pg_temp.worker_facts_plan('one due job');
-- A dense unread population proves the ordered probe can stop without judging
-- an all-job array; the following sparse controls restore the old rows.
UPDATE public.business_events SET context_captured_at=now()-interval '2 hours',
  attributed_at=now()-interval '2 hours';
ANALYZE public.business_events;
SELECT pg_temp.worker_facts_assert('dense due population', 1);
SELECT pg_temp.worker_facts_plan('dense due population');
UPDATE public.business_events SET context_captured_at=now()-interval '20 days',
  attributed_at=now()-interval '20 days' WHERE id NOT IN (SELECT id FROM worker_due_event);
ANALYZE public.business_events;
UPDATE public.business_events SET attribution_confidence=NULL WHERE id=(SELECT id FROM worker_due_event);
SELECT pg_temp.worker_facts_assert('missing admission data', 0);
UPDATE public.business_events SET attribution_confidence=1,payload='{}' WHERE id=(SELECT id FROM worker_due_event);
SELECT pg_temp.worker_facts_assert('missing words', 0);
UPDATE public.business_events SET payload='{"body":"Synthetic new evidence"}' WHERE id=(SELECT id FROM worker_due_event);
UPDATE public.business_events SET event_type='booking.created' WHERE id=(SELECT id FROM worker_due_event);
SELECT pg_temp.worker_facts_assert('status only before evening', 0);
UPDATE public.business_events SET event_type='client.sms_in' WHERE id=(SELECT id FROM worker_due_event);
INSERT INTO public.context_model_call_reservations (run_date,ordinal,phase,reserved_at)
SELECT (now() AT TIME ZONE 'Australia/Perth')::date,g,'attribution',now()
FROM generate_series(1,(public.context_cadence_policy_today()->>'model_call_cap')::integer) g;
SELECT pg_temp.worker_facts_assert('day model cap reached', 0);
DELETE FROM public.context_model_call_reservations;
SELECT pg_temp.worker_facts_assert('due after budget restored', 1);
UPDATE public.automation_switches SET extraction=false;
SELECT pg_temp.worker_facts_assert('lane off with due evidence', 0);
UPDATE public.automation_switches SET extraction=true, all_stop=true;
SELECT pg_temp.worker_facts_assert('all stop', 0);
UPDATE public.automation_switches SET all_stop=false;
UPDATE public.jobs SET metadata='{"do_not_schedule":"true"}' WHERE id=(SELECT job_id FROM worker_due_target);
SELECT pg_temp.worker_facts_assert('office marks holding job', 0);
UPDATE public.jobs SET metadata='{}' WHERE id=(SELECT job_id FROM worker_due_target);
SELECT pg_temp.worker_facts_assert('office releases holding job', 1);
UPDATE public.business_events SET context_captured_at=now(), attributed_at=now() WHERE id=(SELECT id FROM worker_due_event);
SELECT pg_temp.worker_facts_assert('quiet period not elapsed', 0);
UPDATE public.business_events SET context_captured_at=now()-interval '2 hours', attributed_at=now()-interval '2 hours'
WHERE id=(SELECT id FROM worker_due_event);
INSERT INTO public.context_extraction_runs (id, job_id, run_date, phase, status, started_at, lease_expires_at, run_seq)
SELECT gen_random_uuid(), job_id, (now() AT TIME ZONE 'Australia/Perth')::date,
  'extraction','running',now(),now()+interval '30 minutes',1 FROM worker_due_target;
SELECT pg_temp.worker_facts_assert('active lease', 0);
UPDATE public.context_extraction_runs SET status='failed', lease_expires_at=NULL, retry_at=now()+interval '1 hour';
SELECT pg_temp.worker_facts_assert('failed read in backoff', 0);
SELECT pg_temp.worker_facts_assert('retry during backoff still idle', 0);
UPDATE public.context_extraction_runs SET retry_at=now()-interval '1 hour', started_at=now()-interval '2 hours';
SELECT pg_temp.worker_facts_assert('retry due after backoff and cooldown', 1);
UPDATE public.context_extraction_runs SET status='done', finished_at=now(), retry_at=NULL, started_at=now();
SELECT pg_temp.worker_facts_assert('cooldown after done run', 0);
UPDATE public.context_extraction_runs SET started_at=now()-interval '2 hours';
INSERT INTO public.context_extraction_event_receipts (event_id,job_id,run_id)
SELECT e.id,j.job_id,r.id FROM worker_due_event e CROSS JOIN worker_due_target j
JOIN public.context_extraction_runs r ON r.job_id=j.job_id;
SELECT pg_temp.worker_facts_assert('already read evidence', 0);
-- No evidence to read means no due catch-up job, unlike the old wake helper.
INSERT INTO public.context_catchup_jobs (job_id,job_number,priority,requested_at)
SELECT job_id, 'ZZTEST-CATCHUP-DUE',1,now()-interval '1 hour' FROM worker_due_target
ON CONFLICT (job_id) DO UPDATE SET done_at=NULL,done_run_id=NULL,requested_at=excluded.requested_at;
-- Catch-up reads historical rows too, so this is due even with no live unread.
SELECT pg_temp.worker_facts_assert('catch-up pending old evidence', 1);
UPDATE public.context_catchup_jobs SET done_at=now(),done_run_id=gen_random_uuid();
SELECT pg_temp.worker_facts_assert('catch-up completed', 0);
DELETE FROM public.business_events WHERE id NOT IN (SELECT id FROM worker_due_event);
UPDATE public.context_catchup_jobs SET done_at=NULL,done_run_id=NULL WHERE job_id=(SELECT job_id FROM worker_due_target);
-- With no pending catch-up rows (one row marked read), a request alone is not due.
INSERT INTO public.context_catchup_reads (job_id,event_id,read_at,run_id)
SELECT j.job_id,e.id,now(),r.id FROM worker_due_event e CROSS JOIN worker_due_target j
JOIN public.context_extraction_runs r ON r.job_id=j.job_id;
SELECT pg_temp.worker_facts_assert('catch-up with nothing pending', 0);
-- A failed underlying read stays an error; never advertise a successful zero.
DO $c$
DECLARE caught boolean;
BEGIN
  EXECUTE 'CREATE OR REPLACE FUNCTION public.context_jobs_cadence(p_job_ids uuid[]) RETURNS TABLE(job_id uuid,cadence jsonb)
    LANGUAGE plpgsql STABLE AS $x$ BEGIN RAISE EXCEPTION ''synthetic cadence read fault''; END $x$';
  FOR i IN 1..2 LOOP
    caught := false;
    BEGIN
      PERFORM public.context_worker_facts_present();
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM <> 'synthetic cadence read fault' THEN RAISE; END IF;
      caught := true;
    END;
    IF NOT caught THEN RAISE EXCEPTION 'worker facts due: read fault became zero'; END IF;
  END LOOP;
END $c$;
TABLE worker_facts_plans;
SELECT 'PASS: FU20 part 1 canonical due parity, 10000 marks / 2000 jobs indexed probes, lane/holding/read/backoff/retry/catch-up controls, unchanged state and permissions' AS result;
ROLLBACK;
-- Reapply is guarded and idempotent on the actual, unmodified function.
BEGIN;
\ir ../../../migrations/20261117220401_context_worker_facts_due.sql
ROLLBACK;
