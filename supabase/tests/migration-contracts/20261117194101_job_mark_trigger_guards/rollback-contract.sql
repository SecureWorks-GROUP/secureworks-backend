DO $$ BEGIN
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
