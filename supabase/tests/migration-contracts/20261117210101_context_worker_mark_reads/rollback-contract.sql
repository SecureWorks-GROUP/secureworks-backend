DO $c$ BEGIN
  IF pg_get_functiondef('public.context_worker_state()'::regprocedure) IS DISTINCT FROM
    (SELECT definition FROM public.worker_mark_reads_preimage)
    OR to_regprocedure('public.context_worker_notes_due()') IS NOT NULL
    OR to_regclass('public.job_change_mark_events_worker_notes') IS NOT NULL THEN
    RAISE EXCEPTION 'worker mark reads: rollback did not restore predecessor';
  END IF;
END $c$;
SELECT 'PASS: FU20 part 2 exact predecessor restored' AS result;
