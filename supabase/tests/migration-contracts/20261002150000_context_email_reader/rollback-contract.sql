-- After the rollback: no reader object, no reader flag, C1d's lane list back
-- byte for byte, the program flag (EM1's) untouched.
DO $$
BEGIN
 IF to_regclass('public.context_email_attachments') IS NOT NULL THEN RAISE EXCEPTION 'em2 rollback left the ledger'; END IF;
 IF to_regprocedure('public.context_email_reader_flags()') IS NOT NULL OR to_regprocedure('public.context_email_supplier_domains()') IS NOT NULL
  OR to_regprocedure('public.context_email_job_client_emails()') IS NOT NULL OR to_regprocedure('public.context_email_history_scope()') IS NOT NULL
  OR to_regprocedure('public.trigger_context_email_poll()') IS NOT NULL OR to_regprocedure('public.trigger_context_email_sweep()') IS NOT NULL
 THEN RAISE EXCEPTION 'em2 rollback left a function'; END IF;
 IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name IN ('email_reader_v1','email_reader_schedule_v1')) THEN RAISE EXCEPTION 'em2 rollback left a flag row'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='email_capture_v2') THEN RAISE EXCEPTION 'em2 rollback removed EM1''s flag'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.automation_switch_cron_lanes()'::regprocedure)<>'459035de5d3f7f7af49c36f09d9be29e'
 THEN RAISE EXCEPTION 'em2 rollback lanes body'; END IF;
END $$;
