BEGIN;
-- A waiting fact is returned while on. Any candidate read while off throws,
-- proving that zero due is produced without entering the fact selector.
CREATE OR REPLACE FUNCTION public.context_extraction_candidates(p_limit integer DEFAULT 400)
RETURNS TABLE(job_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $stub$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
    WHERE flag_name = 'context_fact_read_v1' AND enabled = false) THEN
    RAISE EXCEPTION 'fact candidates called while off';
  END IF;
  IF current_setting('test.fact_reader_fault', true) = 'on' THEN
    RAISE EXCEPTION 'fixture candidate read failed' USING ERRCODE = '58000';
  END IF;
  RETURN QUERY SELECT '00000000-0000-4000-8000-000000000401'::uuid;
END $stub$;
DO $c$
DECLARE missing jsonb; on_state jsonb; off_state jsonb; failures integer := 0;
BEGIN
  DELETE FROM public.feature_flags WHERE flag_name = 'context_fact_read_v1';
  missing := public.context_worker_state();
  IF missing #>> '{due,facts}' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'fact state: missing flag changed legacy candidate read';
  END IF;
  INSERT INTO public.feature_flags(flag_name, enabled, description)
    VALUES ('context_fact_read_v1', true, 'Contract fixture');
  on_state := public.context_worker_state();
  IF on_state #>> '{due,facts}' IS DISTINCT FROM '1'
    OR (on_state - 'at' - 'flags') IS DISTINCT FROM (missing - 'at' - 'flags') THEN
    RAISE EXCEPTION 'fact state: on differs from missing flag';
  END IF;
  UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'context_fact_read_v1';
  off_state := public.context_worker_state();
  IF off_state #>> '{due,facts}' IS DISTINCT FROM '0'
    OR off_state #>> '{flags,context_fact_read_v1}' IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'fact state: off must publish zero facts and false flag';
  END IF;
  IF ((off_state - 'at' - 'flags') #- '{due,facts}') IS DISTINCT FROM
    ((on_state - 'at' - 'flags') #- '{due,facts}') THEN
    RAISE EXCEPTION 'fact state: off changed another worker phase';
  END IF;
  -- An office flag change is read on the next state call. On-mode faults
  -- remain errors, including a retry; never publish a false empty queue.
  UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'context_fact_read_v1';
  IF public.context_worker_state() #>> '{due,facts}' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'fact state: office flag change not observed';
  END IF;
  PERFORM set_config('test.fact_reader_fault', 'on', true);
  FOR attempt IN 1..2 LOOP
    BEGIN
      PERFORM public.context_worker_state();
    EXCEPTION WHEN SQLSTATE '58000' THEN failures := failures + 1;
    END;
  END LOOP;
  IF failures <> 2 THEN
    RAISE EXCEPTION 'fact state: read fault or retry was hidden';
  END IF;
END $c$;
SELECT 'PASS: P4-04.3 off skips fact candidates; on and missing preserve reads; other state unchanged' AS result;
ROLLBACK;
