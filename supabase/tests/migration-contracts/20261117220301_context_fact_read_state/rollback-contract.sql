BEGIN;
DO $guard$ BEGIN
  IF pg_get_functiondef('public.context_worker_state()'::regprocedure) IS DISTINCT FROM
    (SELECT definition FROM public.fact_read_state_preimage) THEN
    RAISE EXCEPTION 'fact state rollback: exact main body not restored';
  END IF;
END $guard$;
-- Rollback restores the legacy candidate read even with the flag off.
CREATE OR REPLACE FUNCTION public.context_worker_facts_present()
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $stub$
  SELECT 1
$stub$;
INSERT INTO public.feature_flags(flag_name, enabled, description)
  VALUES ('context_fact_read_v1', false, 'Contract fixture')
  ON CONFLICT (flag_name) DO UPDATE SET enabled = false;
DO $c$
BEGIN
  IF public.context_worker_state() #>> '{due,facts}' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'fact state rollback: legacy candidate read not restored';
  END IF;
END $c$;
SELECT 'PASS: P4-04.3 rollback restores legacy fact candidate read' AS result;
ROLLBACK;
