BEGIN;
DO $$
DECLARE v_rows jsonb; v_bad jsonb; v_count integer; v_table text; v_role text;
BEGIN
  IF (SELECT count(*) FROM public.context_ai_job_models WHERE updated_by = 'seed') <> 8
     OR EXISTS (
       SELECT ai_job, role, engine, model, effort, timeout_ms
       FROM public.context_ai_job_models
       EXCEPT SELECT * FROM (VALUES
         ('place-message','doer','codex','gpt-6-luna','xhigh',300000),
         ('read-notes','doer','codex','gpt-6-luna','xhigh',1200000),
         ('write-story','doer','codex','gpt-6-luna','xhigh',240000),
         ('check-story','doer','codex','gpt-6-luna','high',150000),
         ('read-bill','doer','codex','gpt-6-luna','xhigh',600000),
         ('read-bill','checker','claude','claude-opus-5-5','high',600000),
         ('read-facts','doer','codex','gpt-6-luna','xhigh',300000),
         ('read-picture','doer','codex','gpt-6-luna','xhigh',300000)
       ) AS expected(ai_job, role, engine, model, effort, timeout_ms)
     ) THEN
    RAISE EXCEPTION 'ai models contract: eight current choices must be seeded';
  END IF;
  BEGIN
    INSERT INTO public.context_ai_job_models (ai_job, role, engine, model, effort, timeout_ms)
    VALUES ('zztest','judge','codex','fixture-model','high',60000);
    RAISE EXCEPTION 'ai models contract: judge role accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  SELECT payload INTO v_rows FROM zztest_ai_models.rows;
  IF public.context_ai_harness_save(v_rows) <> 2 THEN
    RAISE EXCEPTION 'ai models contract: first save must insert two rows';
  END IF;
  IF public.context_ai_harness_save(v_rows) <> 0 THEN
    RAISE EXCEPTION 'ai models contract: replay must insert zero rows';
  END IF;
  IF (SELECT count(*) FROM public.context_ai_harness_runs WHERE run_id = 'zztest-406') <> 2
     OR NOT EXISTS (
       SELECT 1 FROM public.context_ai_harness_runs WHERE run_id = 'zztest-406'
         AND ai_job = 'read-notes' AND score = 0.9500 AND calls_per_case = 1.00
         AND ran_at = now() AND checker_model IS NULL AND passes_bar
     ) OR NOT EXISTS (
       SELECT 1 FROM public.context_ai_harness_runs WHERE run_id = 'zztest-406'
         AND ai_job = 'read-bill' AND score = 0.9000 AND critical_misses = 1
         AND calls_per_case = 2.00 AND checker_model = 'gpt-6-luna'
         AND ran_at = '2026-11-17T00:00:00Z' AND NOT passes_bar
     ) THEN
    RAISE EXCEPTION 'ai models contract: saved scores differ';
  END IF;
  SELECT jsonb_agg(v_rows->0) INTO v_bad FROM generate_series(1, 201);
  BEGIN
    PERFORM public.context_ai_harness_save(v_bad);
    RAISE EXCEPTION 'ai models contract: oversized batch accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  FOR v_bad IN SELECT value FROM jsonb_array_elements('[null, {}, "rows", 1]') LOOP
    BEGIN
      PERFORM public.context_ai_harness_save(v_bad);
      RAISE EXCEPTION 'ai models contract: non-array accepted';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;
  BEGIN
    PERFORM public.context_ai_harness_save(NULL);
    RAISE EXCEPTION 'ai models contract: SQL null accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  IF public.context_ai_harness_save('[]') <> 0
     OR (SELECT count(*) FROM public.context_ai_harness_runs WHERE run_id = 'zztest-406') <> 2 THEN
    RAISE EXCEPTION 'ai models contract: refused batch changed saved rows';
  END IF;
  FOREACH v_table IN ARRAY ARRAY['context_ai_job_models','context_ai_harness_runs'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_table)::regclass)
       OR NOT has_table_privilege('service_role', 'public.' || v_table, 'SELECT,INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION 'ai models contract: private table boundary differs';
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF has_table_privilege(v_role, 'public.' || v_table, 'SELECT,INSERT,UPDATE,DELETE') THEN
        RAISE EXCEPTION 'ai models contract: browser table access granted';
      END IF;
    END LOOP;
  END LOOP;
  FOREACH v_table IN ARRAY ARRAY['context_ai_harness_save(jsonb)','context_ai_harness_trim(timestamptz,integer)'] LOOP
    IF has_function_privilege('anon', 'public.' || v_table, 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.' || v_table, 'EXECUTE')
       OR NOT has_function_privilege('service_role', 'public.' || v_table, 'EXECUTE') THEN
      RAISE EXCEPTION 'ai models contract: function access differs';
    END IF;
  END LOOP;
  UPDATE public.context_ai_job_models SET chosen_from_run = 'zztest-406' WHERE ai_job = 'read-notes';
  IF public.context_ai_harness_trim(now() + interval '1 day', 200) <> 0 THEN
    RAISE EXCEPTION 'ai models contract: selected run was trimmed';
  END IF;
  UPDATE public.context_ai_job_models SET chosen_from_run = NULL WHERE ai_job = 'read-notes';
  IF public.context_ai_harness_trim('2026-11-17T00:00:00Z', 200) <> 0
     OR public.context_ai_harness_trim(now() + interval '1 day', 1) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.context_ai_harness_runs WHERE ai_job = 'read-notes' AND run_id = 'zztest-406') THEN
    RAISE EXCEPTION 'ai models contract: bounded trim crossed cutoff or order';
  END IF;
  SELECT jsonb_agg(jsonb_set(v_rows->0, '{run_id}', to_jsonb('zztest-trim-' || i)))
    INTO v_rows FROM generate_series(1, 200) i;
  PERFORM public.context_ai_harness_save(v_rows);
  v_count := public.context_ai_harness_trim(now() + interval '1 day', 201);
  IF v_count <> 200 OR (SELECT count(*) FROM public.context_ai_harness_runs) <> 1 THEN
    RAISE EXCEPTION 'ai models contract: trim exceeded two hundred rows';
  END IF;
END $$;
UPDATE public.context_ai_job_models SET timeout_ms = 60000, updated_by = 'operator'
WHERE ai_job = 'place-message' AND role = 'doer';
\ir ../../../migrations/20261117210401_context_ai_job_models.sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.context_ai_job_models
      WHERE ai_job = 'place-message' AND role = 'doer'
        AND timeout_ms = 60000 AND updated_by = 'operator') THEN
    RAISE EXCEPTION 'ai models contract: reapply overwrote operator choice';
  END IF;
END $$;
SELECT 'PASS: P4-06.1 eight seeds, role refusal, save 2/replay 0, private access and bounded trim' AS result;
ROLLBACK;
