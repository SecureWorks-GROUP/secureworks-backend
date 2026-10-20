-- Rollback for 20261020170100_job_client_signoffs.sql.
--
-- Refuses while any sign-off is recorded: a client's signed acceptance is
-- evidence and is never deleted to undo a migration.

BEGIN;
DO $$
BEGIN
  IF to_regclass('public.job_client_signoffs') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.job_client_signoffs) THEN
    RAISE EXCEPTION 'client sign-offs are recorded: resolve them before rolling back 20261020170100_job_client_signoffs';
  END IF;
END $$;

DELETE FROM public.feature_flags WHERE flag_name = 'trade_invoice_requires_client_signoff_v1';
DROP TABLE IF EXISTS public.client_signoff_settings;
DROP TABLE IF EXISTS public.job_client_signoffs;
DROP FUNCTION IF EXISTS public.job_client_signoffs_append_only();

COMMIT;
