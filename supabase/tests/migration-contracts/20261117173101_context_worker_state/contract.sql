BEGIN;
\set worker_state_seed true
\ir setup.sql
DO $c$
DECLARE s jsonb; ids uuid[]; refused boolean := false;
BEGIN
  -- A backed-off pending row must not consume the worker's batch.
  IF EXISTS (SELECT 1 FROM public.context_attribution_due('live', 20)
    WHERE id = '00000000-0000-4000-8000-000000000401') THEN
    RAISE EXCEPTION 'worker state: future backoff returned';
  END IF;
  UPDATE public.context_attribution_attempts SET next_at = now() - interval '1 hour'
    WHERE event_id = '00000000-0000-4000-8000-000000000401';
  IF NOT EXISTS (SELECT 1 FROM public.context_attribution_due('live', 20)
    WHERE id = '00000000-0000-4000-8000-000000000401') THEN
    RAISE EXCEPTION 'worker state: elapsed backoff not returned';
  END IF;
  SELECT array_agg(e.id ORDER BY e.occurred_at, e.id) INTO ids
    FROM public.context_attribution_due('history', 200) e
    WHERE e.id BETWEEN '00000000-0000-4000-8000-000000000401' AND '00000000-0000-4000-8000-000000000409';
  IF ids IS DISTINCT FROM ARRAY['00000000-0000-4000-8000-000000000402',
    '00000000-0000-4000-8000-000000000403']::uuid[] THEN
    RAISE EXCEPTION 'worker state: history lane differs';
  END IF;
  SELECT array_agg(e.id ORDER BY e.occurred_at, e.id) INTO ids
    FROM public.context_attribution_due('live', 200) e
    WHERE e.id BETWEEN '00000000-0000-4000-8000-000000000401' AND '00000000-0000-4000-8000-000000000409';
  IF ids IS DISTINCT FROM ARRAY['00000000-0000-4000-8000-000000000401',
    '00000000-0000-4000-8000-000000000405', '00000000-0000-4000-8000-000000000406',
    '00000000-0000-4000-8000-000000000408']::uuid[] THEN
    RAISE EXCEPTION 'worker state: live lane differs';
  END IF;
  BEGIN
    PERFORM public.context_attribution_due('nope', 1);
  EXCEPTION WHEN invalid_parameter_value THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'worker state: invalid lane accepted'; END IF;

  s := public.context_worker_state();
  IF NOT s ?& ARRAY['at','lanes','ledger_settings','cadence','pass','flags','models','due','marks_newest']
    OR (SELECT count(*) FROM jsonb_object_keys(s)) <> 9 THEN
    RAISE EXCEPTION 'worker state: result keys differ';
  END IF;
  IF s->'pass'->>'run_date' IS DISTINCT FROM ((now() AT TIME ZONE 'Australia/Perth')::date)::text
    OR NOT (s->'due') ?& ARRAY['placement_live','placement_history','facts','notes','stories']
    OR jsonb_typeof(s->'models') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'worker state: worker response shape differs';
  END IF;
  IF to_regclass('public.context_ai_job_models') IS NULL AND s->'models' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'worker state: absent model table must return an empty array';
  END IF;
  IF NOT has_function_privilege('service_role','public.context_worker_state()','EXECUTE')
    OR has_function_privilege('anon','public.context_worker_state()','EXECUTE')
    OR has_function_privilege('authenticated','public.context_worker_state()','EXECUTE')
    OR NOT has_function_privilege('service_role','public.context_attribution_due(text,integer)','EXECUTE')
    OR has_function_privilege('anon','public.context_attribution_due(text,integer)','EXECUTE')
    OR has_function_privilege('authenticated','public.context_attribution_due(text,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'worker state: reads must be service-role only';
  END IF;
END $c$;
EXPLAIN ANALYZE SELECT public.context_worker_state();
SELECT 'PASS: P0-03.1 state shape, placement lanes, backoff and permissions' AS result;
ROLLBACK;

-- Explain the selector's own RETURN QUERY, since EXPLAIN of the PL/pgSQL RPC
-- alone shows only a Function Scan. No copied lane predicate or planner forcing.
BEGIN;
SET LOCAL session_replication_role = replica;
UPDATE public.business_events SET attribution_status = 'unplaced'
  WHERE attribution_status = 'pending_luna';
INSERT INTO public.business_events (id, event_type, attribution_status, occurred_at, metadata)
SELECT gen_random_uuid(), 'worker_state.fixture', 'unplaced',
  timestamptz '2000-01-01 00:00Z' + g * interval '1 minute', '{}'
FROM generate_series(1, 20000) g;
ANALYZE public.business_events;
CREATE TEMP TABLE worker_due_plans (label text, lane text, plan text) ON COMMIT DROP;
CREATE FUNCTION pg_temp.worker_due_plan(p_label text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE query text; lane text; line text; plan text;
BEGIN
  SELECT substring(p.prosrc FROM 'RETURN QUERY[[:space:]]+(.*);[[:space:]]*END')
    INTO query FROM pg_proc p
    WHERE p.oid = 'public.context_attribution_due(text,integer)'::regprocedure;
  IF query IS NULL THEN RAISE EXCEPTION 'worker state: selector query unavailable'; END IF;
  query := regexp_replace(query, '\mp_lane\M', '$1', 'g');
  query := regexp_replace(query, '\mp_limit\M', '$2', 'g');
  FOREACH lane IN ARRAY ARRAY['live', 'history'] LOOP
    plan := '';
    FOR line IN EXECUTE 'EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ' || query
      USING lane, 50 LOOP
      plan := plan || line || E'\n';
    END LOOP;
    INSERT INTO worker_due_plans VALUES (p_label, lane, plan);
    IF plan NOT LIKE '%Index Scan using business_events_pending_luna_due%'
      OR plan LIKE '%Seq Scan on business_events%' THEN
      RAISE EXCEPTION 'worker state: due plan does not use pending index (%, %): %', p_label, lane, plan;
    END IF;
  END LOOP;
END $f$;
SELECT pg_temp.worker_due_plan('empty backlog');
-- Unchecked pending rows cannot use the narrower pending-marker index.
INSERT INTO public.business_events (id, event_type, attribution_status, occurred_at, metadata)
VALUES
  ('00000000-0000-4000-8000-000000000410', 'worker_state.fixture', 'pending_luna', '1999-01-01 00:00Z', '{}'),
  ('00000000-0000-4000-8000-000000000411', 'worker_state.fixture', 'pending_luna', '1999-01-02 00:00Z', '{"capture_mode":"backfill"}');
ANALYZE public.business_events;
SELECT pg_temp.worker_due_plan('sparse backlog');
-- Prove this plan assertion detects the missing index. The caught exception
-- rolls the DROP back, preserving the forward stack and existing break proof.
DO $c$
BEGIN
  BEGIN
    DROP INDEX public.business_events_pending_luna_due;
    PERFORM pg_temp.worker_due_plan('missing index');
    RAISE EXCEPTION 'worker state: missing index was not detected';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'worker state: due plan does not use pending index%' THEN RAISE; END IF;
  END;
END $c$;
TABLE worker_due_plans;
SELECT 'PASS: P0-03.1 both due lanes use the pending index for empty and sparse backlogs; missing index detected' AS result;
ROLLBACK;
