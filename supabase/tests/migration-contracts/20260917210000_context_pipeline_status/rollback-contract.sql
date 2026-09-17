DO $$ BEGIN
 IF to_regprocedure('public.context_coverage()') IS NOT NULL
  OR to_regprocedure('public.context_pipeline_status()') IS NOT NULL
 THEN RAISE EXCEPTION 'heartbeat rollback left functions'; END IF;
END $$;
