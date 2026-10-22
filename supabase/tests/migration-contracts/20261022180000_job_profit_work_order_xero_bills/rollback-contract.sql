-- After the down migration the three switches and the four new columns are
-- gone, and the original profit view and function still answer.
\set ON_ERROR_STOP on

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.feature_flags
    WHERE flag_name IN (
      'job_profit_work_order_labour_v1',
      'job_profit_xero_project_cost_v1',
      'job_profit_patio_quote_v1'
    )
  ) THEN
    RAISE EXCEPTION 'rollback left a job profit flag behind';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'v_job_profit'
      AND column_name IN (
        'margin_source', 'margin_cost_ex',
        'expected_labour_quote_ex', 'work_order_agreed_labour_ex'
      )
  ) THEN
    RAISE EXCEPTION 'rollback left a new v_job_profit column behind';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'job_profit_flag_on',
        'job_profit_patio_ex',
        'job_profit_patio_rule3_statuses',
        'job_profit_patio_quote',
        'job_profit_bill_job_tokens',
        'job_profit_bill_is_installer',
        'job_profit_link_bill'
      )
  ) THEN
    RAISE EXCEPTION 'rollback left a job profit helper behind';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'v_job_profit'
      AND column_name = 'quote_costs_incomplete'
  ) THEN
    RAISE EXCEPTION 'rollback dropped quote_costs_incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'v_job_profit'
      AND column_name = 'invoice_emailed_ex'
  ) THEN
    RAISE EXCEPTION 'rollback dropped invoice_emailed_ex';
  END IF;

  IF (
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'v_job_profit'
    ORDER BY ordinal_position DESC LIMIT 1
  ) IS DISTINCT FROM 'quote_costs_incomplete' THEN
    RAISE EXCEPTION 'rollback did not restore quote_costs_incomplete as the last column';
  END IF;

  IF position('installer_bill_unconfirmed' in pg_get_viewdef('public.v_job_profit'::regclass)) = 0 THEN
    RAISE EXCEPTION 'rollback lost JP-12 installer_bill_unconfirmed from v_job_profit';
  END IF;

  -- DROP VIEW drops column comments. These are the ten 20261020220000 left.
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('committed_open_ex', 'Priced open purchase orders with no invoice emailed and no bill placed, ex GST. Committed, not actual: never in actual_cost_ex. An order with no price is never here as $0: see ordered_not_billed_count.'),
      ('ordered_not_billed_count', 'Sent purchase orders with no price (every Dispatch order) and no invoice or bill yet. A count, never a dollar figure.'),
      ('ordered_not_billed_over_30_count', 'Of ordered_not_billed_count, those first sent 30 or more Perth days ago (flag ordered_not_billed_over_30_days).'),
      ('invoice_emailed_count', 'Purchase orders whose supplier invoice was emailed (invoice_received_at) with no bill linked to the order (the bill may be on the job without that link). Never nothing owed.'),
      ('invoice_emailed_ex', 'Ex-GST amount of the priced orders in invoice_emailed_count. Null when none carries a price. Not in committed_open_ex or actual_cost_ex.'),
      ('xero_project_expenses_ex', 'Expenses on record against the job''s Xero Project (name-linked only). Evidence only: not the job''s full cost, never part of actual_cost_ex, profit_ex or any total. Trade app labour may sit outside it.'),
      ('actual_cost_ex', 'Line-level actual cost ex GST (trade charges, supplier bills, materials facts). Never a Xero Project total.'),
      ('quoted_ex', 'Sent or accepted quote value ex GST (job_quote_values). Null with no sent quote; never the live price.'),
      ('expected_cost_ex', 'Expected cost fixed at the quote (expected_source frozen_at_acceptance, accepted_quote_revision or sent_quote_revision). Null with none; never the live pricing estimate.'),
      ('quote_costs_incomplete', 'True when no expected cost is fixed because the revision the quote stands on (newest accepted, else newest sent) sealed its costs as still to confirm (cost_estimates.costs_complete false). Not the same as a job with no costed quote. Never a figure.')
    ) AS expected(attname, description)
    WHERE col_description(
      'public.v_job_profit'::regclass,
      (SELECT a.attnum FROM pg_attribute a
        WHERE a.attrelid = 'public.v_job_profit'::regclass
          AND a.attname = expected.attname)
    ) IS DISTINCT FROM expected.description
  ) THEN
    RAISE EXCEPTION 'rollback did not restore a v_job_profit column comment';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'job_profit'
  ) THEN
    RAISE EXCEPTION 'rollback dropped job_profit';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'xero_invoices'
      AND column_name = 'reference'
  ) THEN
    RAISE EXCEPTION 'rollback dropped xero_invoices.reference';
  END IF;
END $$;

SELECT * FROM public.v_job_profit LIMIT 0;
SELECT * FROM public.job_profit('00000000-0000-0000-0000-000000000000'::uuid);
