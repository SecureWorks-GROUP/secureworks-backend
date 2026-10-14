-- Prerequisites for 20261009100000_context_job_story_text: nothing new. Every
-- table and function it reads (jobs, feature_flags, the reservations and the
-- admission, the ledger settings and generations, the story card and its
-- ledger read, the lead rule, xero_invoices, job_documents, business_events)
-- and the three roles it grants to come from earlier registered cases. This
-- check fails early, and by name, if one is missing, and proves the switch row
-- is not there yet.
DO $$
DECLARE r text; f text;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.jobs', 'public.feature_flags', 'public.context_model_call_reservations', 'public.context_ledger_settings',
   'public.context_ledger_generations', 'public.xero_invoices', 'public.job_documents', 'public.business_events',
   'public.automation_switches'] LOOP
  IF to_regclass(f) IS NULL THEN RAISE EXCEPTION 'job story text setup: % is missing from the registered stack', f; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)',
   'public.context_job_story_ledger(uuid,uuid,timestamptz)', 'public.context_lead_monitored_jobs(uuid[],timestamptz)',
   'public.reserve_context_model_call(text,uuid,uuid)', 'public.automation_lane_enabled(text)', 'public.context_cadence_policy()'] LOOP
  IF to_regprocedure(f) IS NULL THEN RAISE EXCEPTION 'job story text setup: % is missing from the registered stack', f; END IF;
 END LOOP;
 FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN RAISE EXCEPTION 'job story text setup: role % is missing', r; END IF;
 END LOOP;
 IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'context_job_story_text_v1') THEN
  RAISE EXCEPTION 'job story text setup: the switch row exists before the migration';
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reserve_context_model_call(text,uuid,uuid)'::regprocedure)
    IS DISTINCT FROM '0d741538d7874ce63d48e54d8645d18c' THEN
  RAISE EXCEPTION 'job story text setup: the admission is not the call budget body (production''s pre-image)';
 END IF;
END $$;
