-- Rollback for 20261021100000_job_receipt_sender.sql.
--
-- Drops the receipt switch, its trigger and the claims. Roll the matching ops-api and
-- xero-sync back first (they read these). The receipt_sent / receipt_not_sent /
-- receipt_dry_run job_events rows stay as history; without the claims, a re-applied
-- sender cannot see which invoices were already emailed, so re-apply only with the
-- switch off and read those job_events before turning it on again. Re-running it is a
-- no-op.

DROP TABLE IF EXISTS public.job_receipt_claims;
DROP TRIGGER IF EXISTS job_closeout_settings_receipt_mode_since ON public.job_closeout_settings;
DROP FUNCTION IF EXISTS public.job_closeout_settings_receipt_mode_since();
ALTER TABLE public.job_closeout_settings DROP CONSTRAINT IF EXISTS job_closeout_settings_receipt_sender_mode_check;
ALTER TABLE public.job_closeout_settings DROP COLUMN IF EXISTS receipt_sender_mode_since;
ALTER TABLE public.job_closeout_settings DROP COLUMN IF EXISTS receipt_sender_mode;
