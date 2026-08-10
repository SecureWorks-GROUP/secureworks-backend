-- Rollback for 20260809000001_makesafe_d1_reconcile_sms_kill_switch.sql.

ALTER TABLE public.makesafe_notify_settings
  DROP COLUMN IF EXISTS d1_reconcile_enabled;
