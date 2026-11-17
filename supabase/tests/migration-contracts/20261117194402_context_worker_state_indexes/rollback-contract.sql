DO $c$ BEGIN
  IF pg_get_functiondef('public.context_worker_state()'::regprocedure)
    IS DISTINCT FROM (SELECT definition FROM public.worker_state_followup_preimage)
    OR to_regprocedure('public.context_worker_facts_present()') IS NOT NULL
    OR to_regclass('public.business_events_worker_facts_present') IS NOT NULL
    OR to_regclass('public.context_catchup_jobs_worker_present') IS NOT NULL
    THEN
    RAISE EXCEPTION 'worker state follow-up: rollback did not restore exact state';
  END IF;
END $c$;
SELECT 'PASS: P0-03.1 follow-up rollback restores exact worker state and removes only new reads/indexes' AS result;
