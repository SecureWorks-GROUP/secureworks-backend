-- Prerequisites for 20261030170000_job_labour_employer_oncost. Earlier
-- registered cases create the engine views and the trade invoice tables. This
-- adds only columns the views read that a stub may lack. Fail closed if a table
-- is gone.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.v_job_cost_events', 'public.v_trade_charge_resolved', 'public.v_job_profit',
                           'public.trade_invoices', 'public.trade_invoice_lines', 'public.jobs', 'public.users'] LOOP
    IF to_regclass(t) IS NULL THEN
      RAISE EXCEPTION 'job labour setup: % missing from the registered stack', t;
    END IF;
  END LOOP;
END $$;

ALTER TABLE public.trade_invoices
  ADD COLUMN IF NOT EXISTS super_amount numeric,
  ADD COLUMN IF NOT EXISTS net_pay numeric,
  ADD COLUMN IF NOT EXISTS super_basis text,
  ADD COLUMN IF NOT EXISTS recurring_deduction_label text,
  ADD COLUMN IF NOT EXISTS recurring_deduction_amount numeric;
