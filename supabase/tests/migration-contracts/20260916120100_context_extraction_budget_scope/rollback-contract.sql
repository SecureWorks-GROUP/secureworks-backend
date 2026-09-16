DO $$ BEGIN
 IF to_regprocedure('public.context_job_extractable(public.jobs)') IS NOT NULL THEN RAISE EXCEPTION 'D4 rollback left predicate'; END IF;
 IF to_regprocedure('public.context_extraction_candidates(integer)') IS NULL OR to_regprocedure('public.context_extraction_events(uuid,integer)') IS NULL THEN RAISE EXCEPTION 'D4 rollback lost extraction functions'; END IF;
 IF NOT has_function_privilege('service_role','public.context_extraction_candidates(integer)','EXECUTE') THEN RAISE EXCEPTION 'D4 rollback grant'; END IF;
END $$;
