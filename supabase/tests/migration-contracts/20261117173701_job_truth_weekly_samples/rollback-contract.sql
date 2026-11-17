DO $c$ BEGIN
 IF to_regclass('public.job_truth_weekly_samples') IS NOT NULL
   OR to_regclass('public.job_truth_weekly_scores') IS NOT NULL
   OR to_regprocedure('public.job_truth_weekly_draw(date,integer)') IS NOT NULL
   OR to_regprocedure('public.job_truth_weekly_record(date,uuid,uuid,jsonb,jsonb)') IS NOT NULL
   OR to_regprocedure('public.job_truth_weekly_install()') IS NOT NULL THEN
   RAISE EXCEPTION 'weekly rollback left sample surfaces'; END IF;
 IF to_regclass('public.job_pages') IS NULL OR to_regprocedure('public.job_page_refresh(uuid)') IS NULL THEN
   RAISE EXCEPTION 'weekly rollback changed the stored job pages'; END IF;
END $c$;
