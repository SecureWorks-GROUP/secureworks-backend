DROP FUNCTION public.set_trade_pay_setting(text, text, uuid);
DROP TABLE public.trade_pay_settings_changes;
DROP FUNCTION public.trade_pay_settings_changes_append_only();
ALTER TABLE public.trade_pay_settings
  DROP COLUMN repayment_account_code,
  DROP COLUMN not_job_work_account_code;
