-- Prerequisites for 20261007070000_context_placement_grades: nothing new. The
-- tables it reads (jobs, business_events, event_threads with P4's retired_at),
-- the functions it calls (the scorecard's lane rule, the payload mismatch
-- classifier, the rules-on ladder and the placement keys) and the three roles
-- it grants to are created by earlier registered cases. This check fails early,
-- and by name, if one is missing, and proves the migration's names are free.
DO $$
DECLARE r text;
BEGIN
 FOREACH r IN ARRAY ARRAY['public.jobs', 'public.business_events', 'public.event_threads'] LOOP
  IF to_regclass(r) IS NULL THEN RAISE EXCEPTION 'placement grades setup: % is missing from the registered stack', r; END IF;
 END LOOP;
 FOREACH r IN ARRAY ARRAY['public.context_scorecard_lane_of(text,text,text,text,text,jsonb)',
   'public.context_payload_job_mismatch_rows()', 'public.resolve_context_attribution(public.business_events,boolean,boolean)',
   'public.context_payload_job_is_guess(public.business_events)', 'public.context_linked_status(text)',
   'public.context_contact_job_timeline(text,timestamp with time zone)', 'public.context_ref_jobs(text[])',
   'public.context_job_ref_tokens(text)', 'public.context_bucket_text(public.business_events)',
   'public.context_event_text(public.business_events)', 'public.context_event_identity(public.business_events)',
   'public.context_contact_for_key(text,text)'] LOOP
  IF to_regprocedure(r) IS NULL THEN RAISE EXCEPTION 'placement grades setup: % is missing from the registered stack', r; END IF;
 END LOOP;
 FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN RAISE EXCEPTION 'placement grades setup: role % is missing', r; END IF;
 END LOOP;
 IF to_regclass('public.context_placement_grades') IS NOT NULL
  OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname LIKE 'context_placement_%') THEN
  RAISE EXCEPTION 'placement grades setup: a context_placement_ name exists before the migration';
 END IF;
END $$;
