DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.trade_recurring_deductions WHERE kind='repayment') THEN RAISE EXCEPTION 'repayment_rows_exist'; END IF;
END $$;
DROP FUNCTION IF EXISTS public.trade_repayment_balance(uuid);
ALTER TABLE public.trade_recurring_deductions
  DROP CONSTRAINT IF EXISTS trade_recurring_deductions_repayment_check,
  DROP CONSTRAINT IF EXISTS trade_recurring_deductions_kind_check,
  DROP COLUMN IF EXISTS kind, DROP COLUMN IF EXISTS balance_total,
  DROP COLUMN IF EXISTS xero_account_code, DROP COLUMN IF EXISTS set_by, DROP COLUMN IF EXISTS stopped_at;
DELETE FROM public.feature_flags WHERE flag_name='trade_repayments_v1';
