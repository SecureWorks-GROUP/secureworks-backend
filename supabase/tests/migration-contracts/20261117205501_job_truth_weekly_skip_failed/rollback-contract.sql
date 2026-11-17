DO $c$ BEGIN
 IF position('weekly_draw_page_unavailable' in pg_get_functiondef('public.job_truth_weekly_draw(date,integer)'::regprocedure))=0
   OR has_function_privilege('authenticated','public.job_truth_weekly_draw(date,integer)','EXECUTE') THEN
   RAISE EXCEPTION 'FU15 rollback did not restore the private original draw';
 END IF;
END $c$;
