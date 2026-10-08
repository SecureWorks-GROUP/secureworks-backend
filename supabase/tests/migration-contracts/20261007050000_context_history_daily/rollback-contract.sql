-- After the history daily rollback: M4's CRM list and the 20261005210000 lane
-- list are back word for word, the seven new functions are gone, the grants are
-- as they were, and M4's surface still answers. (The order where the deep email
-- history PR applied first is proved in contract.sql, section 8.)
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_ghl_history_live_jobs()'::regprocedure) <> '49eb23015b724a29058c11b2743954bf'
  OR coalesce(obj_description('public.context_ghl_history_live_jobs()'::regprocedure, 'pg_proc'), '') NOT LIKE 'M4: the live jobs%'
 THEN RAISE EXCEPTION 'hd rollback did not restore M4''s list'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.automation_switch_cron_lanes()'::regprocedure) <> '99e6d70e80a79e548f2478b65fc6cd78'
 THEN RAISE EXCEPTION 'hd rollback did not restore the lane list'; END IF;
 IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
   AND p.proname IN ('context_history_daily_policy', 'context_history_monitored_jobs', 'context_history_crm_rows', 'context_history_crm_jobs',
    'context_history_crm_summary', 'trigger_xero_history_daily', 'context_history_xero_daily_status'))
 THEN RAISE EXCEPTION 'hd rollback left a function'; END IF;
 IF has_function_privilege('anon', 'public.context_ghl_history_live_jobs()', 'EXECUTE')
  OR has_function_privilege('authenticated', 'public.context_ghl_history_live_jobs()', 'EXECUTE')
  OR NOT has_function_privilege('service_role', 'public.context_ghl_history_live_jobs()', 'EXECUTE')
  OR NOT has_function_privilege('service_role', 'public.automation_switch_cron_lanes()', 'EXECUTE')
 THEN RAISE EXCEPTION 'hd rollback grants'; END IF;
 -- M4's surface still answers.
 PERFORM count(*) FROM public.context_ghl_history_live_jobs();
 PERFORM public.context_ghl_history_progress();
 PERFORM count(*) FROM public.context_ghl_history_link_due(10);
END $$;
