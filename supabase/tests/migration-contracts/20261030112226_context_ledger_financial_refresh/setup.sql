-- Uses the registered real source/signature and ledger stack.
DO $$ BEGIN
 IF to_regprocedure('public.context_job_story_record_sig(uuid)') IS NULL OR to_regprocedure('public.context_job_story_money_sig(uuid)') IS NULL THEN RAISE EXCEPTION 'financial refresh prerequisites missing'; END IF;
END $$;
