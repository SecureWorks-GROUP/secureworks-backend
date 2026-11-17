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
