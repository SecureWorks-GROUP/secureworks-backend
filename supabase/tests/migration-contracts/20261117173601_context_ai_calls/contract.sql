BEGIN;
TRUNCATE public.context_ai_calls;
DO $$
DECLARE v_rows jsonb; v_count integer; v_bad jsonb;
BEGIN
  SELECT payload INTO v_rows FROM zztest_ai_calls.rows;
  v_count := public.context_ai_calls_log(v_rows);
  IF v_count <> 2 OR (SELECT count(*) FROM public.context_ai_calls WHERE source = 'live') <> 2 THEN
    RAISE EXCEPTION 'context ai calls contract: two live rows must read back';
  END IF;
  IF (SELECT count(*) FROM public.context_ai_calls_daily) <> 1 OR NOT EXISTS (
    SELECT 1 FROM public.context_ai_calls_daily WHERE day = DATE '2026-11-17'
      AND ai_job = 'read-facts' AND spec_id = 'read-facts' AND spec_version = 0
      AND engine = 'codex' AND model = 'fixture-model' AND effort IS NULL
      AND calls = 2 AND answered = 1 AND median_ms = 200 AND abs(p95_ms - 290) < 0.000001
  ) THEN
    RAISE EXCEPTION 'context ai calls contract: Perth daily aggregation differs';
  END IF;
  BEGIN
    PERFORM public.context_ai_calls_log(jsonb_set(v_rows, '{0,ai_job}', '"Bad Job"'));
    RAISE EXCEPTION 'context ai calls contract: invalid job accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  SELECT jsonb_agg(v_rows->0) INTO v_bad FROM generate_series(1, 501);
  BEGIN
    PERFORM public.context_ai_calls_log(v_bad);
    RAISE EXCEPTION 'context ai calls contract: oversized batch accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  FOR v_bad IN SELECT value FROM jsonb_array_elements('[null, {}, "rows", 1]') LOOP
    BEGIN
      PERFORM public.context_ai_calls_log(v_bad);
      RAISE EXCEPTION 'context ai calls contract: non-array accepted';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;
  BEGIN
    PERFORM public.context_ai_calls_log(NULL);
    RAISE EXCEPTION 'context ai calls contract: SQL null accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  IF (SELECT count(*) FROM public.context_ai_calls) <> 2
     OR public.context_ai_calls_log('[]') <> 0 THEN
    RAISE EXCEPTION 'context ai calls contract: refused batch left rows';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.context_ai_calls'::regclass)
     OR has_table_privilege('anon', 'public.context_ai_calls', 'SELECT')
     OR has_table_privilege('authenticated', 'public.context_ai_calls', 'INSERT')
     OR has_table_privilege('anon', 'public.context_ai_calls_daily', 'SELECT')
     OR has_table_privilege('authenticated', 'public.context_ai_calls_daily', 'SELECT')
     OR has_function_privilege('authenticated', 'public.context_ai_calls_log(jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.context_ai_calls_log(jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.context_ai_calls_log(jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.context_ai_calls_trim(timestamptz,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.context_ai_calls_trim(timestamptz,integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.context_ai_calls_trim(timestamptz,integer)', 'EXECUTE')
     OR NOT has_table_privilege('service_role', 'public.context_ai_calls_daily', 'SELECT') THEN
    RAISE EXCEPTION 'context ai calls contract: access boundary differs';
  END IF;
  v_count := public.context_ai_calls_trim('2026-11-17T00:00:00Z', 1);
  IF v_count <> 1
     OR (SELECT count(*) FROM public.context_ai_calls) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.context_ai_calls WHERE at = '2026-11-17T01:00:00Z') THEN
    RAISE EXCEPTION 'context ai calls contract: bounded trim crossed cutoff';
  END IF;
  PERFORM public.context_ai_calls_log((SELECT jsonb_agg(v_rows->0) FROM generate_series(1,500)));
  v_count := public.context_ai_calls_trim('2026-11-18T00:00:00Z', 501);
  IF v_count <> 500
     OR (SELECT count(*) FROM public.context_ai_calls) <> 1 THEN
    RAISE EXCEPTION 'context ai calls contract: trim exceeded 500 rows';
  END IF;
END $$;
SELECT 'PASS: P4-01.1 batch log, refusal, Perth daily read and private access' AS result;
ROLLBACK;
