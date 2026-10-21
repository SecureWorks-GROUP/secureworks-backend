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
