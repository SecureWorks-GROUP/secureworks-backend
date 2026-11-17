DO $$ BEGIN
 IF to_regprocedure('public.job_cost_lines_sync_credit_notes(text[])') IS NULL THEN
 RAISE EXCEPTION 'followup8 prerequisite missing'; END IF;
END $$;
