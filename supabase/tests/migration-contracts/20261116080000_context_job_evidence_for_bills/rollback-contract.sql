-- After the down: every function the migration made is gone.
DO $c$
BEGIN
 IF to_regprocedure('public.context_job_evidence_for_bills(text[],boolean)') IS NOT NULL
    OR to_regprocedure('public.context_job_evidence_policy()') IS NOT NULL
    OR to_regprocedure('public.context_job_evidence_number_key(text)') IS NOT NULL
    OR to_regprocedure('public.context_job_evidence_text_numbers(text)') IS NOT NULL
    OR to_regprocedure('public.context_job_evidence_is_statement(text)') IS NOT NULL THEN
  RAISE EXCEPTION 'job evidence rollback: every function must be dropped';
 END IF;
END $c$;
