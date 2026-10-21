-- Deliberately remove the start-instant stamp: the contract must fail.
DROP TRIGGER job_closeout_settings_receipt_mode_since ON public.job_closeout_settings;
