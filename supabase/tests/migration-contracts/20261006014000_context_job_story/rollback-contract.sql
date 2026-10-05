-- After the down migration: every story function is gone; the record layer and the
-- ledger tables remain.
DO $rb$
DECLARE f text;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)',
   'public.context_job_story_facts(uuid,timestamptz)','public.context_job_story_ledger(uuid,uuid,timestamptz)',
   'public.context_job_story_meta(uuid,timestamptz)','public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)',
   'public.context_client_story(uuid,timestamptz)','public.context_story_scorecard(timestamptz)',
   'public.context_story_scorecard_jobs(uuid,integer)'] LOOP
  IF to_regprocedure(f) IS NOT NULL THEN RAISE EXCEPTION 'story rollback contract: % survived the rollback', f; END IF;
 END LOOP;
 IF to_regprocedure('public.context_job_record_loops(uuid[],timestamptz)') IS NULL OR to_regclass('public.context_ledger_items') IS NULL THEN
  RAISE EXCEPTION 'story rollback contract: the record layer and the ledger must remain';
 END IF;
END $rb$;
