-- Before retiring the fact reader: coverage stops counting old facts, while
-- live ledger coverage stays. ON, missing or unreadable switch preserves main.
-- No switches, records, triggers or schedules are written.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.context_fact_reads_on()
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $function$ BEGIN
  RETURN coalesce((SELECT f.enabled FROM public.feature_flags f
    WHERE f.flag_name = 'context_fact_read_v1'), true);
EXCEPTION WHEN OTHERS THEN
  RETURN true;
END $function$;
REVOKE ALL ON FUNCTION public.context_fact_reads_on() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_fact_reads_on() TO service_role;

DO $migration$
DECLARE
  definition text := pg_get_functiondef('public.context_coverage()'::regprocedure);
  body_hash text := (SELECT md5(prosrc) FROM pg_proc
    WHERE oid = 'public.context_coverage()'::regprocedure); BEGIN
  -- Rule 15: exact main body from 20261102200000; reapply only this successor.
  IF body_hash = '2c6900b05df24773145650d0fbd0aa3b' THEN RETURN; END IF;
  IF body_hash IS DISTINCT FROM 'dbee3427213fbaea92215aceb6187c00' THEN
    RAISE EXCEPTION 'context_coverage: Rule 15 pre-image changed';
  END IF;
  definition := replace(definition, $before$ WITH older AS (SELECT DISTINCT job_id FROM public.current_job_context_facts),$before$, $after$ WITH fact_mode AS MATERIALIZED (SELECT public.context_fact_reads_on() AS enabled),
 older AS (SELECT DISTINCT job_id FROM public.current_job_context_facts WHERE (SELECT enabled FROM fact_mode)),$after$);
  definition := replace(definition, $before$ SELECT jsonb_build_object($before$,
    $after$ SELECT CASE WHEN (SELECT enabled FROM fact_mode) THEN '{}'::jsonb
  ELSE '{"facts_retired":true}'::jsonb END || jsonb_build_object($after$);
  EXECUTE definition;
END $migration$;
