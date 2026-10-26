-- Rollback for 20261026160000_job_deposit_advance.sql.
--
-- Drops the deposit advance switch and the per-job record. Roll the matching ops-api and
-- xero-sync back first (they read these). The status_changed, deposit_advance_dry_run,
-- deposit_received_text and deposit_flagged job_events rows stay as history; without the
-- record, a re-applied deposit advance cannot see which clients were already texted, so
-- re-apply only with the switch off and read those job_events before turning it on again.
-- Re-running it is a no-op.

DROP TABLE IF EXISTS public.job_deposit_advance_state;
ALTER TABLE public.job_closeout_settings DROP CONSTRAINT IF EXISTS job_closeout_settings_deposit_advance_mode_check;
ALTER TABLE public.job_closeout_settings DROP COLUMN IF EXISTS deposit_advance_mode;
