-- The registered predecessors supply the real legacy view, cost lines and stores.
DO $setup$ BEGIN
 IF to_regclass('public.job_cost_lines') IS NULL
  OR to_regclass('public.job_cost_events_stored') IS NULL
  OR to_regclass('public.v_job_cost_events') IS NULL THEN
  RAISE EXCEPTION 'P2-01.7 prerequisites missing';
 END IF;
END $setup$;
