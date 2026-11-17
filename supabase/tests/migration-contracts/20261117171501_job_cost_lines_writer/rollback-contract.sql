DO $$ BEGIN
 IF to_regprocedure('public.job_cost_lines_upsert_documents(jsonb)') IS NOT NULL
 OR to_regprocedure('public.job_cost_lines_set_state(uuid,text,jsonb,text,bigint,text)') IS NOT NULL
 OR to_regprocedure('public.job_cost_lines_refollow(text,text)') IS NOT NULL
 OR to_regclass('public.job_cost_line_parts') IS NULL THEN RAISE EXCEPTION 'writer rollback failed'; END IF;
END $$;
