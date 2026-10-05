-- After the B-2 rollback: the schedule's objects are gone, M4's due list and
-- reservation and the 20261002150000 lane list are back, and M4's surface works.
DO $$
DECLARE r jsonb;
BEGIN
 IF to_regclass('public.context_ghl_history_link_attempts') IS NOT NULL THEN RAISE EXCEPTION 'b2 rollback left the link attempt record'; END IF;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.context_ghl_history_contacts'::regclass AND attname='reads_requested_at' AND NOT attisdropped)
 THEN RAISE EXCEPTION 'b2 rollback left reads_requested_at'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
  AND p.proname IN ('context_ghl_history_schedule_policy','context_ghl_history_day_limit','context_ghl_history_due_at','record_ghl_link_attempt',
   'context_ghl_history_link_due','context_ghl_history_request_reads','context_ghl_history_progress','trigger_ghl_history_schedule'))
 THEN RAISE EXCEPTION 'b2 rollback left a function'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ghl_history_due(integer)'::regprocedure)<>'a52b2ffa5db7ca748e1d1069ec97da00'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.reserve_ghl_history_run(integer,text)'::regprocedure)<>'dc0848e3b103f0e5c8a9a3947bebc154'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.automation_switch_cron_lanes()'::regprocedure)<>'5c1e0e526a74d5b4ad612792c7f076cc'
 THEN RAISE EXCEPTION 'b2 rollback did not restore the earlier bodies'; END IF;
 IF has_function_privilege('anon','public.reserve_ghl_history_run(integer,text)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.context_ghl_history_due(integer)','EXECUTE')
 THEN RAISE EXCEPTION 'b2 rollback grants'; END IF;
 -- M4's due list still answers with its own shape.
 r:=public.context_ghl_history_due(5);
 IF r->'daily_job_limit'<>'100' OR r ? 'jobs_charged' THEN RAISE EXCEPTION 'b2 rollback due %',r; END IF;
END $$;
