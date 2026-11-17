-- Restore the exact main coverage body. Refuse a later replacement.
SET LOCAL lock_timeout = '5s';
DO $rollback$
DECLARE
  definition text := pg_get_functiondef('public.context_coverage()'::regprocedure);
  body_hash text := (SELECT md5(prosrc) FROM pg_proc
    WHERE oid = 'public.context_coverage()'::regprocedure); BEGIN
  IF body_hash = 'dbee3427213fbaea92215aceb6187c00' THEN RETURN; END IF;
  IF body_hash IS DISTINCT FROM '2c6900b05df24773145650d0fbd0aa3b' THEN
    RAISE EXCEPTION 'context_coverage: retirement rollback pre-image changed';
  END IF;
  definition := replace(definition, $before$ WITH fact_mode AS MATERIALIZED (SELECT public.context_fact_reads_on() AS enabled),
 older AS (SELECT DISTINCT job_id FROM public.current_job_context_facts WHERE (SELECT enabled FROM fact_mode)),$before$, $after$ WITH older AS (SELECT DISTINCT job_id FROM public.current_job_context_facts),$after$);
  definition := replace(definition, $before$ SELECT CASE WHEN (SELECT enabled FROM fact_mode) THEN '{}'::jsonb
  ELSE '{"facts_retired":true}'::jsonb END || jsonb_build_object($before$,
    $after$ SELECT jsonb_build_object($after$);
  EXECUTE definition;
END $rollback$;
DROP FUNCTION IF EXISTS public.context_fact_reads_on();
