-- The registered ledger store supplies the runs, the reservations and the backoff function; no substitute.
DO $$ BEGIN
 IF to_regprocedure('public.context_ledger_failures(uuid[])') IS NULL
 OR to_regclass('public.context_model_call_reservations') IS NULL
 OR to_regclass('public.context_extraction_runs') IS NULL THEN
  RAISE EXCEPTION 'notes backoff prerequisites missing';
 END IF;
END $$;
