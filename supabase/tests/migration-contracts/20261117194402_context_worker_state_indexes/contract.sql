BEGIN;
-- Inspect this slice before its later fact-read switch overlay.
\ir ../../../rollbacks/20261117205201_context_fact_read_state_down.sql
SET LOCAL session_replication_role = replica;
-- Every fixture stays in this rolled-back transaction. No switch is changed live.
DELETE FROM public.automation_switches;
INSERT INTO public.automation_switches (id, all_stop, extraction, attribution, capture)
VALUES (1, false, false, false, false);
DELETE FROM public.business_events;
DELETE FROM public.context_catchup_jobs;

DO $c$
DECLARE before_body text; actual text;
BEGIN
  SELECT definition INTO before_body FROM public.worker_state_followup_preimage;
  SELECT pg_get_functiondef('public.context_worker_state()'::regprocedure) INTO actual;
  IF actual IS DISTINCT FROM replace(before_body,
    'CASE WHEN EXISTS (SELECT 1 FROM public.context_extraction_candidates(1)) THEN 1 ELSE 0 END',
    'public.context_worker_facts_present()') THEN
    RAISE EXCEPTION 'worker state follow-up: unexpected state delta';
  END IF;
  IF public.context_worker_facts_present() <> 0 THEN
    RAISE EXCEPTION 'worker state follow-up: lane off must be zero';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.context_worker_facts_present()', 'EXECUTE')
    OR has_function_privilege('anon', 'public.context_worker_facts_present()', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.context_worker_facts_present()', 'EXECUTE') THEN
    RAISE EXCEPTION 'worker state follow-up: service-role permission differs';
  END IF;
END $c$;

-- A large irrelevant population must not be inspected by either existence probe.
INSERT INTO public.business_events (id, job_id, context_captured_at, metadata)
SELECT gen_random_uuid(), gen_random_uuid(), now(), '{"written_as":"authenticated"}'::jsonb
FROM generate_series(1, 20000);
INSERT INTO public.context_catchup_jobs (job_id, job_number, priority, done_at, done_run_id)
SELECT gen_random_uuid(), 'ZZTEST-CATCHUP-' || g, 1, now(), gen_random_uuid() FROM generate_series(1, 20000) g;
ANALYZE public.business_events;
ANALYZE public.context_catchup_jobs;
UPDATE public.automation_switches SET extraction = true WHERE id = 1;

CREATE TEMP TABLE worker_followup_plans (label text, plan text) ON COMMIT DROP;
CREATE FUNCTION pg_temp.worker_followup_plan(p_label text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE query text; line text; plan text := '';
BEGIN
  SELECT prosrc INTO query FROM pg_proc WHERE oid = 'public.context_worker_facts_present()'::regprocedure;
  FOR line IN EXECUTE 'EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ' || query LOOP
    plan := plan || line || E'\n';
  END LOOP;
  INSERT INTO worker_followup_plans VALUES (p_label, plan);
  IF plan NOT LIKE '%Index Only Scan using business_events_worker_facts_present%'
    OR plan NOT LIKE '%Index Only Scan using context_catchup_jobs_worker_present%'
    OR plan LIKE '%Seq Scan on business_events%' OR plan LIKE '%Seq Scan on context_catchup_jobs%' THEN
    RAISE EXCEPTION 'worker state follow-up: wake plan not index served: %', plan;
  END IF;
END $f$;

SELECT pg_temp.worker_followup_plan('lane on, empty work set');
DO $c$ BEGIN
  IF public.context_worker_facts_present() <> 0 THEN
    RAISE EXCEPTION 'worker state follow-up: empty work set must be zero';
  END IF;
END $c$;

-- Old live captures do not wake; non-live captures do not wake either.
INSERT INTO public.business_events (id, job_id, context_captured_at, metadata)
VALUES (gen_random_uuid(), gen_random_uuid(), (public.context_cadence_policy()->>'live_since')::timestamptz - interval '1 second',
  '{"written_as":"service_role","capture_mode":"live"}'),
 (gen_random_uuid(), gen_random_uuid(), now(), '{"written_as":"service_role","capture_mode":"backfill"}');
DO $c$ BEGIN
  IF public.context_worker_facts_present() <> 0 THEN
    RAISE EXCEPTION 'worker state follow-up: old or backfilled evidence woke live work';
  END IF;
END $c$;

-- A catch-up request must wake even with no live evidence (and even if blocked).
INSERT INTO public.context_catchup_jobs (job_id, job_number, priority)
VALUES ('00000000-0000-4000-8000-000000001901', 'ZZTEST-CATCHUP-OPEN', 1);
DO $c$ BEGIN
  IF public.context_worker_facts_present() <> 1 THEN
    RAISE EXCEPTION 'worker state follow-up: unfinished catch-up missed';
  END IF;
END $c$;
UPDATE public.context_catchup_jobs SET done_at = now(), done_run_id = gen_random_uuid() WHERE done_at IS NULL;
-- One live candidate wakes without deciding its linked status, source admission,
-- receipts, cooldown or model budget. All are left to the canonical judge.
INSERT INTO public.business_events (id, job_id, context_captured_at, metadata)
VALUES (gen_random_uuid(), gen_random_uuid(), greatest(now(), (public.context_cadence_policy()->>'live_since')::timestamptz),
  '{"written_as":"service_role"}');
ANALYZE public.business_events;
ANALYZE public.context_catchup_jobs;
SELECT pg_temp.worker_followup_plan('lane on, sparse live work');
DO $c$
DECLARE s jsonb;
BEGIN
  IF public.context_worker_facts_present() <> 1 THEN
    RAISE EXCEPTION 'worker state follow-up: live candidate missed';
  END IF;
  s := public.context_worker_state();
  IF s->'due'->>'facts' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'worker state follow-up: state does not consume wake signal';
  END IF;
  UPDATE public.automation_switches SET extraction = false WHERE id = 1;
  IF public.context_worker_facts_present() <> 0 OR public.context_worker_state()->'due'->>'facts' <> '0' THEN
    RAISE EXCEPTION 'worker state follow-up: populated lane off must be zero';
  END IF;
  UPDATE public.automation_switches SET extraction = true, all_stop = true WHERE id = 1;
  IF public.context_worker_facts_present() <> 0 THEN
    RAISE EXCEPTION 'worker state follow-up: all-stop must be zero';
  END IF;
END $c$;

-- Negative controls roll their drops back and prove plan failures are detected.
UPDATE public.automation_switches SET all_stop = false WHERE id = 1;
DO $c$ BEGIN
  BEGIN
    DROP INDEX public.business_events_worker_facts_present;
    PERFORM pg_temp.worker_followup_plan('missing live index');
    RAISE EXCEPTION 'worker state follow-up: missing live index undetected';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'worker state follow-up: wake plan not index served:%' THEN RAISE; END IF;
  END;
  BEGIN
    DROP INDEX public.context_catchup_jobs_worker_present;
    PERFORM pg_temp.worker_followup_plan('missing catch-up index');
    RAISE EXCEPTION 'worker state follow-up: missing catch-up index undetected';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'worker state follow-up: wake plan not index served:%' THEN RAISE; END IF;
  END;
END $c$;
TABLE worker_followup_plans;
-- Run after the plan checks so reapply cannot heal a deliberately dropped index
-- before the runner's broken-contract phase gets to observe it.
\ir ../../../migrations/20261117194402_context_worker_state_indexes.sql
DO $c$ BEGIN
  IF pg_get_functiondef('public.context_worker_state()'::regprocedure) IS DISTINCT FROM
    (SELECT replace(definition,
      'CASE WHEN EXISTS (SELECT 1 FROM public.context_extraction_candidates(1)) THEN 1 ELSE 0 END',
      'public.context_worker_facts_present()')
      FROM public.worker_state_followup_preimage) THEN
    RAISE EXCEPTION 'worker state follow-up: reapply changed state';
  END IF;
END $c$;
SELECT 'PASS: P0-03.1 conservative facts signal, lane-on indexed plans, unchanged newest read, permissions and missing-index controls' AS result;
ROLLBACK;
