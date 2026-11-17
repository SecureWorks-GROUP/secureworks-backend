-- P1-09.1. No repayment is created by this migration.
INSERT INTO public.feature_flags(flag_name, enabled, description)
VALUES ('trade_repayments_v1', false, 'Repayments with a balance on trade invoices, set by the pay run approvers.')
ON CONFLICT (flag_name) DO NOTHING;
ALTER TABLE public.trade_recurring_deductions
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'recurring',
  ADD COLUMN IF NOT EXISTS balance_total numeric(12,2),
  ADD COLUMN IF NOT EXISTS xero_account_code text,
  ADD COLUMN IF NOT EXISTS set_by uuid,
  ADD COLUMN IF NOT EXISTS stopped_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.trade_recurring_deductions'::regclass AND conname='trade_recurring_deductions_kind_check') THEN
    ALTER TABLE public.trade_recurring_deductions ADD CONSTRAINT trade_recurring_deductions_kind_check CHECK (kind IN ('recurring','repayment'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.trade_recurring_deductions'::regclass AND conname='trade_recurring_deductions_repayment_check') THEN
    ALTER TABLE public.trade_recurring_deductions ADD CONSTRAINT trade_recurring_deductions_repayment_check
      CHECK (kind <> 'repayment' OR (balance_total IS NOT NULL AND balance_total > 0 AND xero_account_code IS NOT NULL AND btrim(xero_account_code) <> ''));
  END IF;
END $$;
CREATE OR REPLACE FUNCTION public.trade_repayment_balance(p_id uuid)
RETURNS numeric LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT CASE WHEN r.kind='repayment' THEN greatest(0, r.balance_total - coalesce((
    SELECT sum(i.recurring_deduction_amount) FROM public.trade_invoices i
    WHERE i.recurring_deduction_id=r.id AND i.status NOT IN ('draft','ops-reject')
  ),0)) END FROM public.trade_recurring_deductions r WHERE r.id=p_id;
$$;
REVOKE ALL ON FUNCTION public.trade_repayment_balance(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.trade_repayment_balance(uuid) TO service_role;
