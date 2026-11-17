BEGIN;
-- Prove this predecessor's exact parity before the later fact-read gate.
\ir ../../../rollbacks/20261117220301_context_fact_read_state_down.sql
SET LOCAL session_replication_role = replica;
TRUNCATE public.job_change_mark_events, public.job_change_marks_base,
  public.job_notes_marks_seen, public.job_page_marks_seen;

-- Compare the complete old and new RPC answers, allowing only the call timestamp.
DO $c$
DECLARE definition text;
BEGIN
  SELECT p.definition INTO definition FROM public.worker_mark_reads_preimage p;
  EXECUTE replace(definition, 'public.context_worker_state()', 'pg_temp.worker_before_state()');
END $c$;
CREATE FUNCTION pg_temp.worker_mark_parity(label text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE old_state jsonb; new_state jsonb;
BEGIN
  old_state := pg_temp.worker_before_state() - 'at';
  new_state := public.context_worker_state() - 'at';
  IF old_state IS DISTINCT FROM new_state THEN
    RAISE EXCEPTION 'worker mark reads: parity failed (%): % versus %', label, old_state, new_state;
  END IF;
END $f$;
SELECT pg_temp.worker_mark_parity('no marks');
-- Lane-on parity: the facts expression remains the predecessor's expression.
INSERT INTO public.automation_switches (id, all_stop, extraction, attribution, capture)
VALUES (1, false, true, false, false)
ON CONFLICT (id) DO UPDATE SET all_stop = false, extraction = true;
SELECT pg_temp.worker_mark_parity('extraction on, no marks');

CREATE TEMP TABLE worker_mark_jobs (job_id uuid PRIMARY KEY, ordinal integer) ON COMMIT DROP;
INSERT INTO worker_mark_jobs SELECT gen_random_uuid(), g FROM generate_series(1, 2000) g;
INSERT INTO public.jobs (id, org_id, type, status, job_number)
SELECT job_id, '00000000-0000-4000-8000-000000000001', 'fencing', 'accepted',
  'ZZTEST-MARK-' || ordinal FROM worker_mark_jobs;
INSERT INTO public.job_change_mark_events (job_id, marked_at, source)
SELECT j.job_id, timestamptz '2001-01-01 00:00Z' + g * interval '1 second', 'status'
FROM worker_mark_jobs j CROSS JOIN generate_series(1, 5) g;
INSERT INTO public.job_change_marks_base (job_id, last_marked_at, notes_done_at)
SELECT job_id, '2000-01-01 00:00Z', '2000-01-01 00:00Z' FROM worker_mark_jobs;
INSERT INTO public.job_notes_marks_seen (job_id, notes_done_at)
SELECT job_id, '2001-01-02 00:00Z' FROM worker_mark_jobs;
ANALYZE public.jobs;
ANALYZE public.job_change_mark_events;
ANALYZE public.job_change_marks_base;
ANALYZE public.job_notes_marks_seen;

CREATE TEMP TABLE worker_mark_plans (label text, reader text, plan text) ON COMMIT DROP;
CREATE FUNCTION pg_temp.worker_mark_plan(label text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE reader text; query text; plan jsonb; relation_name text; relations text[];
BEGIN
  FOREACH reader IN ARRAY ARRAY['context_worker_marks_newest', 'context_worker_notes_due'] LOOP
    SELECT p.prosrc INTO query FROM pg_proc p WHERE p.oid = ('public.' || reader || '()')::regprocedure;
    EXECUTE 'EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF, FORMAT JSON) ' || query INTO plan;
    INSERT INTO worker_mark_plans VALUES (label, reader, plan::text);
    relations := ARRAY['job_change_mark_events', 'job_change_marks_base', 'jobs'];
    IF reader = 'context_worker_notes_due' THEN
      relations := array_append(relations, 'job_notes_marks_seen');
    END IF;
    FOREACH relation_name IN ARRAY relations LOOP
      IF NOT jsonb_path_exists(plan,
        '$.** ? (@."Relation Name" == $relation && (@."Node Type" == "Index Scan" || @."Node Type" == "Index Only Scan"))',
        jsonb_build_object('relation', relation_name))
        OR jsonb_path_exists(plan,
        '$.** ? (@."Relation Name" == $relation && @."Node Type" == "Seq Scan")',
        jsonb_build_object('relation', relation_name)) THEN
        RAISE EXCEPTION 'worker mark reads: % plan not indexed: %',
          CASE WHEN reader = 'context_worker_notes_due' THEN 'notes' ELSE 'newest' END, plan;
      END IF;
    END LOOP;
    -- The two capped sources may sort at most 50 candidates each. Raw history
    -- must stream in job/time order, not sort all marks via a weaker index.
    IF reader = 'context_worker_notes_due' AND jsonb_path_exists(plan,
      '$.** ? ((@."Node Type" == "Sort" || @."Node Type" == "Incremental Sort") && @."Actual Rows" > 100)') THEN
      RAISE EXCEPTION 'worker mark reads: notes plan not indexed: unbounded history sort: %', plan;
    END IF;
  END LOOP;
END $f$;

SELECT pg_temp.worker_mark_parity('10000 acknowledged marks, 2000 jobs');
SELECT pg_temp.worker_mark_plan('10000 acknowledged marks, 2000 jobs');
DO $c$ BEGIN
  IF public.context_worker_notes_due() <> 0 THEN
    RAISE EXCEPTION 'worker mark reads: acknowledged work counted';
  END IF;
END $c$;

-- One raw-only due job, even when it sorts last. No arbitrary job cap.
UPDATE public.job_notes_marks_seen SET notes_done_at = '2000-01-01 00:00Z'
WHERE job_id = (SELECT max(job_id::text)::uuid FROM worker_mark_jobs);
SELECT pg_temp.worker_mark_parity('one raw due job');
SELECT pg_temp.worker_mark_plan('one raw due job');
DO $c$ BEGIN
  IF public.context_worker_notes_due() <> 1 THEN
    RAISE EXCEPTION 'worker mark reads: one raw job not counted exactly once';
  END IF;
END $c$;

-- Both stores due for the same job, then more than 50 jobs. Preserve distinct cap.
UPDATE public.job_change_marks_base SET last_marked_at = '2002-01-01 00:00Z';
UPDATE public.job_notes_marks_seen SET notes_done_at = '2000-01-01 00:00Z';
ANALYZE public.job_change_marks_base;
SELECT pg_temp.worker_mark_parity('both sources due, distinct cap 50');
SELECT pg_temp.worker_mark_plan('both sources due, distinct cap 50');
DO $c$ BEGIN
  IF public.context_worker_notes_due() <> 50 THEN
    RAISE EXCEPTION 'worker mark reads: cap changed';
  END IF;
END $c$;

-- A real acknowledgement, a later mark, a retry, and real bounded compaction.
SELECT public.job_marks_notes_seen('2003-01-01 00:00Z');
SELECT pg_temp.worker_mark_parity('acknowledged through real writer');
SELECT public.job_mark_changed((SELECT job_id FROM worker_mark_jobs WHERE ordinal = 1), 'status');
SELECT pg_temp.worker_mark_parity('new mark after acknowledgement');
SELECT pg_temp.worker_mark_parity('repeat read does not acknowledge');
CREATE TEMP TABLE worker_before_fold AS SELECT public.context_worker_state() - 'at' AS state;
UPDATE public.job_change_mark_events SET page_pending = false;
SELECT public.job_change_marks_fold(10000);
SELECT pg_temp.worker_mark_parity('after real bounded fold');
DO $c$ BEGIN
  IF public.context_worker_state() - 'at' IS DISTINCT FROM (SELECT state FROM worker_before_fold) THEN
    RAISE EXCEPTION 'worker mark reads: folding changed answer';
  END IF;
END $c$;

-- Legacy base acknowledgement and deleted-job raw history must behave as the view.
TRUNCATE public.job_change_mark_events, public.job_change_marks_base, public.job_notes_marks_seen;
INSERT INTO public.job_change_marks_base (job_id, last_marked_at, notes_done_at)
SELECT job_id, '2002-01-01 00:00Z', '2003-01-01 00:00Z' FROM worker_mark_jobs WHERE ordinal = 1;
INSERT INTO public.job_change_mark_events (job_id, marked_at, source)
SELECT job_id, '2001-01-01 00:00Z', 'status' FROM worker_mark_jobs WHERE ordinal = 1;
INSERT INTO public.job_change_mark_events (job_id, marked_at, source)
VALUES (gen_random_uuid(), '2099-01-01 00:00Z', 'status');
SELECT pg_temp.worker_mark_parity('legacy acknowledgement and newest orphan');
DO $c$ BEGIN
  IF public.context_worker_notes_due() <> 0
    OR public.context_worker_marks_newest() IS DISTINCT FROM timestamptz '2002-01-01 00:00Z' THEN
    RAISE EXCEPTION 'worker mark reads: legacy acknowledgement or orphan leaked';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.context_worker_notes_due()', 'EXECUTE')
    OR has_function_privilege('anon', 'public.context_worker_notes_due()', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.context_worker_marks_newest()', 'EXECUTE') THEN
    RAISE EXCEPTION 'worker mark reads: permission changed';
  END IF;
END $c$;
-- An unavailable indexed read must fail the RPC, never report an idle queue.
-- Restore the real helper before proving the retry has the same complete answer.
DO $c$
DECLARE definition text; refused boolean := false;
BEGIN
  definition := pg_get_functiondef('public.context_worker_notes_due()'::regprocedure);
  EXECUTE $fault$CREATE OR REPLACE FUNCTION public.context_worker_notes_due() RETURNS bigint
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $body$
    BEGIN RAISE EXCEPTION 'worker mark read unavailable' USING ERRCODE = 'XX000'; END $body$$fault$;
  BEGIN
    PERFORM public.context_worker_state();
  EXCEPTION WHEN SQLSTATE 'XX000' THEN refused := true;
  END;
  EXECUTE definition;
  IF NOT refused THEN RAISE EXCEPTION 'worker mark reads: failed read became idle'; END IF;
END $c$;
SELECT pg_temp.worker_mark_parity('retry after failed read');
TABLE worker_mark_plans;
\ir ../../../migrations/20261117210101_context_worker_mark_reads.sql
SELECT pg_temp.worker_mark_parity('reapply');
SELECT 'PASS: FU20 part 2 full-state parity, capped distinct notes, indexed 10000-mark/2000-job plans, acknowledgement, retry, fold, orphan and permissions' AS result;
ROLLBACK;
