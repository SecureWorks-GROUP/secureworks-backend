-- After the M4 rollback: every M4 object is gone and the functions it called
-- are untouched.
DO $$
BEGIN
 IF to_regclass('public.context_ghl_history_contacts') IS NOT NULL OR to_regclass('public.context_ghl_contact_links') IS NOT NULL
 THEN RAISE EXCEPTION 'm4 rollback left a table'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
  AND (p.proname LIKE 'context_ghl_history%' OR p.proname IN ('record_ghl_history_contact','capture_ghl_history_event','link_job_ghl_contact','reverse_ghl_contact_link','reserve_ghl_history_run')))
 THEN RAISE EXCEPTION 'm4 rollback left a function'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.capture_business_event(jsonb)')) IS DISTINCT FROM '4819869e6dcc40d5cd19a7eba295392c'
 THEN RAISE EXCEPTION 'm4 rollback changed capture_business_event'; END IF;
 -- The legacy surface still works: the one writer saves a row.
 IF public.capture_business_event(jsonb_build_object('event_type','client.reply','source','m4-rollback','provider_message_id','ghl:m4RollbackRow01',
  'metadata',jsonb_build_object('capture_mode','live')))->>'outcome'<>'inserted' THEN RAISE EXCEPTION 'm4 rollback broke the writer'; END IF;
END $$;
