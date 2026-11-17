DO $c$ BEGIN
  IF pg_get_functiondef('public.context_worker_facts_present()'::regprocedure) IS DISTINCT FROM
      (SELECT helper_definition FROM public.worker_facts_due_preimage)
    OR pg_get_functiondef('public.context_worker_state()'::regprocedure) IS DISTINCT FROM
      (SELECT state_definition FROM public.worker_facts_due_preimage)
    OR to_regclass('public.business_events_worker_facts_jobs') IS NOT NULL THEN
    RAISE EXCEPTION 'worker facts due: rollback did not restore exact helper and state';
  END IF;
END $c$;
SELECT 'PASS: FU20 part 1 rollback restores exact helper; state untouched' AS result;
