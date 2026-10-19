-- After the down migration: the engine views are back to 20261009130000's
-- shape (no CFO-12 columns, no po_ordered / po_invoice_emailed sources) and
-- job_profit(uuid) answers again.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF to_regclass('public.v_job_profit') IS NULL OR to_regclass('public.v_job_cost_events') IS NULL THEN
    RAISE EXCEPTION 'cfo12 rollback: an engine view is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'v_job_profit'
                AND column_name IN ('ordered_not_billed_count', 'ordered_not_billed_over_30_count',
                                    'invoice_emailed_count', 'invoice_emailed_ex')) THEN
    RAISE EXCEPTION 'cfo12 rollback: a CFO-12 column survived the down migration';
  END IF;
  IF pg_get_viewdef('public.v_job_cost_events'::regclass) LIKE '%po_invoice_emailed%' THEN
    RAISE EXCEPTION 'cfo12 rollback: v_job_cost_events still has the CFO-12 states';
  END IF;
  IF to_regprocedure('public.job_profit(uuid)') IS NULL THEN
    RAISE EXCEPTION 'cfo12 rollback: job_profit(uuid) is missing';
  END IF;
  PERFORM 1 FROM public.job_profit('00000000-0000-0000-0000-000000000000'::uuid);
  IF has_table_privilege('anon', 'public.v_job_profit', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.v_job_profit', 'SELECT') THEN
    RAISE EXCEPTION 'cfo12 rollback: v_job_profit grants not restored';
  END IF;
END $$;
