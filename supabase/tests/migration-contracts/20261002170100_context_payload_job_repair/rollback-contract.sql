-- After the down migration the repair function is gone and the admission rule
-- it pairs with is still in place.
DO $$
BEGIN
 IF to_regprocedure('public.context_payload_job_repair(boolean,integer)') IS NOT NULL OR to_regprocedure('public.context_payload_job_mismatch_rows()') IS NOT NULL THEN RAISE EXCEPTION 'repair rollback left the function'; END IF;
 IF to_regprocedure('public.context_event_source_admissible(public.business_events)') IS NULL THEN RAISE EXCEPTION 'repair rollback removed the admission rule'; END IF;
END $$;
