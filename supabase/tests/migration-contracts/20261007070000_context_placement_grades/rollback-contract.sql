-- After the placement grades rollback: the table and all seven functions are
-- gone, and everything they read is untouched.
DO $$
DECLARE f text;
BEGIN
 IF to_regclass('public.context_placement_grades') IS NOT NULL THEN RAISE EXCEPTION 'placement rollback: the grades table was left behind'; END IF;
 IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname LIKE 'context_placement_%') THEN
  RAISE EXCEPTION 'placement rollback: a context_placement_ function was left behind';
 END IF;
 FOREACH f IN ARRAY ARRAY['public.jobs', 'public.business_events', 'public.event_threads'] LOOP
  IF to_regclass(f) IS NULL THEN RAISE EXCEPTION 'placement rollback: % was lost', f; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_scorecard_lane_of(text,text,text,text,text,jsonb)', 'public.context_payload_job_mismatch_rows()',
   'public.resolve_context_attribution(public.business_events,boolean,boolean)', 'public.context_contact_job_timeline(text,timestamp with time zone)'] LOOP
  IF to_regprocedure(f) IS NULL THEN RAISE EXCEPTION 'placement rollback: % was lost', f; END IF;
 END LOOP;
END $$;
