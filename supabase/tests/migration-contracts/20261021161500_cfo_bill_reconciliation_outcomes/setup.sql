-- Prerequisites for 20261021161500_cfo_bill_reconciliation_outcomes (H7).
-- Earlier registered cases build the bill tables, the allocation rows and the
-- split function (20261020181800). Fail closed if any is gone.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.xero_invoices', 'public.job_materials_facts', 'public.materials_reconciliation_queue',
                           'public.trade_invoices', 'public.v_bill_allocation_balance'] LOOP
    IF to_regclass(t) IS NULL THEN
      RAISE EXCEPTION 'h7 setup: % missing from the registered stack', t;
    END IF;
  END LOOP;
  IF to_regprocedure('public.allocate_bill_split(text, jsonb, numeric, text, text)') IS NULL
     OR to_regprocedure('public.job_cost_installer_bill(jsonb)') IS NULL
     OR to_regprocedure('public.job_cost_credit_share(jsonb, numeric)') IS NULL THEN
    RAISE EXCEPTION 'h7 setup: 20261020181800 functions missing';
  END IF;
END $$;

ALTER TABLE public.xero_invoices ADD COLUMN IF NOT EXISTS amount_due numeric;
