-- After the down migration: the lane list this migration found, byte for byte
-- (B-5's, or the history daily slice's when 20261007050000 is registered
-- before this one; contract section 12b proves that order on its own), every
-- object of the deep load gone, the flag row gone, and W7's 60-day load
-- untouched.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.automation_switch_cron_lanes()'::regprocedure)
   <>(CASE WHEN to_regprocedure('public.context_history_daily_policy()') IS NULL THEN '99e6d70e80a79e548f2478b65fc6cd78'
     ELSE '81cbebf914f537b0b85870196cbd0f75' END)
  OR EXISTS(SELECT 1 FROM public.automation_switch_cron_lanes() WHERE cron_jobname='outlook-mail-deep-history')
 THEN RAISE EXCEPTION 'deep rollback: lane list %',(SELECT md5(prosrc) FROM pg_proc WHERE oid='public.automation_switch_cron_lanes()'::regprocedure); END IF;
 IF has_function_privilege('anon','public.automation_switch_cron_lanes()','EXECUTE')
  OR NOT has_function_privilege('service_role','public.automation_switch_cron_lanes()','EXECUTE')
 THEN RAISE EXCEPTION 'deep rollback: lane list grants'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
   AND (p.proname LIKE 'context_email_deep%' OR p.proname LIKE 'context_email_history_reach%' OR p.proname='trigger_context_email_deep_history'))
 THEN RAISE EXCEPTION 'deep rollback: a function remains'; END IF;
 IF to_regclass('public.context_email_deep_plan') IS NOT NULL OR to_regclass('public.context_email_deep_reach') IS NOT NULL
  OR to_regclass('public.context_email_deep_members') IS NOT NULL
 THEN RAISE EXCEPTION 'deep rollback: a table remains'; END IF;
 IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='email_reader_deep_v1') THEN RAISE EXCEPTION 'deep rollback: the flag row remains'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.trigger_context_email_history()'::regprocedure)<>'e3bf7cccc57fbbd2f740565695321a66'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_email_history_status()'::regprocedure)<>'528c22d64509a47cf039859d09ae1447'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.trigger_context_email_poll()'::regprocedure)<>'1430e54e4443b839865d3b4874793e15'
  OR to_regclass('public.context_email_history_plan') IS NULL
 THEN RAISE EXCEPTION 'deep rollback: the 60-day load was touched'; END IF;
END $$;
