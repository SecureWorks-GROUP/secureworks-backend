-- Undo 20261103160000_crew_pay_lands_as_labour: crew draft lines count as actual cost again
-- (v_job_cost_events back to md5 a3ab8d8be6e4ff755736cbe53a7d131f) and the B2 measure is dropped.
DO $down$
DECLARE
  v_def text := pg_get_viewdef('public.v_job_cost_events'::regclass, true);
  v_new text := 'r.cost_lane <> ''advance''::text AND ti.status <> ''draft''::text AS is_actual';
  v_old text := 'r.cost_lane <> ''advance''::text AS is_actual';
BEGIN
  IF md5(v_def) <> '926479b3b905dea4b087834c37438572' THEN
    RAISE EXCEPTION 'v_job_cost_events is not the 20261103160000 definition (md5 %)', md5(v_def);
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_cost_events AS ' || replace(v_def, v_new, v_old);
  IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true)) <> 'a3ab8d8be6e4ff755736cbe53a7d131f' THEN
    RAISE EXCEPTION 'v_job_cost_events after the undo is not the 20261103050000 definition';
  END IF;
END
$down$;

DROP FUNCTION IF EXISTS public.job_profit_crew_pay_landing(timestamptz);
