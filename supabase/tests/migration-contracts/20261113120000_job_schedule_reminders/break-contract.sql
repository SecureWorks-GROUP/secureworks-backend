-- Deliberately drop the mode check: the contract must fail.
ALTER TABLE public.job_closeout_settings DROP CONSTRAINT job_closeout_settings_schedule_reminder_mode_check;
