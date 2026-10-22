-- After the down migration: one row per bill again, no split function or
-- balance view, the queue without split, and the engine views without credit
-- rows; job_profit(uuid) still answers.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF to_regclass('public.job_materials_facts_invoice_uidx') IS NULL THEN
    RAISE EXCEPTION 'cfo18 rollback: one-row-per-bill index not restored';
  END IF;
  IF to_regclass('public.job_materials_facts_invoice_whole_uidx') IS NOT NULL
     OR to_regprocedure('public.job_materials_facts_no_mix()') IS NOT NULL THEN
    RAISE EXCEPTION 'cfo18 rollback: no-mix guard survived';
  END IF;
  IF to_regclass('public.v_bill_allocation_balance') IS NOT NULL
     OR to_regprocedure('public.allocate_bill_split(text, jsonb, numeric, text, text)') IS NOT NULL THEN
    RAISE EXCEPTION 'cfo18 rollback: split surface survived';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
              AND table_name = 'materials_reconciliation_queue' AND column_name IN ('overhead_ex', 'overhead_note')) THEN
    RAISE EXCEPTION 'cfo18 rollback: queue overhead columns survived';
  END IF;
  IF pg_get_viewdef('public.v_job_cost_events'::regclass) LIKE '%supplier_credit%'
     OR pg_get_viewdef('public.v_job_revenue_events'::regclass) LIKE '%credit_applied%' THEN
    RAISE EXCEPTION 'cfo18 rollback: credit rows survived in the engine';
  END IF;
  IF pg_get_viewdef('public.v_job_cost_events'::regclass) NOT LIKE '%po_invoice_emailed%' THEN
    RAISE EXCEPTION 'cfo18 rollback: cost events lost the CFO-12 states';
  END IF;
  IF to_regprocedure('public.job_cost_installer_bill(jsonb)') IS NOT NULL
     OR pg_get_viewdef('public.v_job_profit'::regclass) LIKE '%installer%' THEN
    RAISE EXCEPTION 'jp12 rollback: installer confirmation survived';
  END IF;
  PERFORM 1 FROM public.job_profit('00000000-0000-0000-0000-000000000000'::uuid);
  IF has_table_privilege('anon', 'public.v_job_cost_events', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.v_job_cost_events', 'SELECT') THEN
    RAISE EXCEPTION 'cfo18 rollback: engine grants not restored';
  END IF;
END $$;
