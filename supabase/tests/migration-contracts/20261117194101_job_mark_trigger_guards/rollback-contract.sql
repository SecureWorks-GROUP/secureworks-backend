DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM cron.job WHERE jobname IN ('job-pages-refresh','job-pages-nightly'))
  OR NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='unrelated-contract-timer') THEN
  RAISE EXCEPTION 'trigger guard rollback: page timer remains or unrelated timer removed';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'job_mark_changed_%') THEN
  RAISE EXCEPTION 'trigger guard rollback: installed trigger remains';
 END IF;
 IF pg_get_functiondef('public.job_change_mark_triggers_install()'::regprocedure)
  LIKE '%job_mark_changed_business_events_update%' THEN
  RAISE EXCEPTION 'trigger guard rollback: original installer not restored';
 END IF;
 IF pg_get_functiondef('public.job_change_mark_triggers_remove()'::regprocedure)
  LIKE '%job_mark_changed_xero_invoices_update%' THEN
  RAISE EXCEPTION 'trigger guard rollback: original remover not restored';
 END IF;
END $$;
