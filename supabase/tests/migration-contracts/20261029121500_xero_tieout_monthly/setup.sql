-- Prerequisites for 20261029121500_xero_tieout_monthly. Earlier registered
-- cases create the bills copy, the allocation rows, Bills to place, the jobs
-- and the AI bill reader's trade-app mirror rule. The bank copy
-- (20260316000004 and 20260317000001, never a registered case) is stubbed
-- here with its production columns. Fail closed, by name, if anything else
-- the tie-out reads is gone.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.xero_invoices', 'public.job_materials_facts',
                           'public.materials_reconciliation_queue', 'public.jobs'] LOOP
    IF to_regclass(t) IS NULL THEN
      RAISE EXCEPTION 'xero tie-out setup: % missing from the registered stack', t;
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['public.materials_ai_trade_mirror(text,jsonb)', 'public.job_cost_installer_bill(jsonb)'] LOOP
    IF to_regprocedure(t) IS NULL THEN
      RAISE EXCEPTION 'xero tie-out setup: % missing from the registered stack', t;
    END IF;
  END LOOP;
  IF to_regprocedure('public.xero_tieout_monthly(date,integer,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'xero tie-out setup: the tie-out exists before the migration';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.xero_bank_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  xero_txn_id text NOT NULL,
  account_id text NOT NULL,
  account_name text,
  txn_date date NOT NULL,
  txn_type text,
  contact_name text,
  contact_id text,
  reference text,
  description text,
  amount numeric(12,2) NOT NULL,
  is_reconciled boolean DEFAULT true,
  synced_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now(),
  status text,
  line_items jsonb,
  sub_total numeric(12,2),
  total_tax numeric(12,2),
  UNIQUE (org_id, xero_txn_id)
);
