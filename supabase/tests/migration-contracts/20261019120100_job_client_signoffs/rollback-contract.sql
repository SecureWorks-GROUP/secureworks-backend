-- Rollback contract: 20261019120100_job_client_signoffs. The down removes both tables, the trigger
-- function and the switch, and leaves jobs and job_media alone.
\set ON_ERROR_STOP on
DO $$
BEGIN
 IF to_regclass('public.job_client_signoffs') IS NOT NULL OR to_regclass('public.client_signoff_settings') IS NOT NULL THEN
  RAISE EXCEPTION 'client signoff rollback contract: a table survived the down';
 END IF;
 IF to_regprocedure('public.job_client_signoffs_append_only()') IS NOT NULL THEN
  RAISE EXCEPTION 'client signoff rollback contract: the trigger function survived the down';
 END IF;
 IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'trade_invoice_requires_client_signoff_v1') THEN
  RAISE EXCEPTION 'client signoff rollback contract: the switch survived the down';
 END IF;
 IF to_regclass('public.jobs') IS NULL OR to_regclass('public.job_media') IS NULL THEN
  RAISE EXCEPTION 'client signoff rollback contract: the down removed a table it does not own';
 END IF;
END $$;
