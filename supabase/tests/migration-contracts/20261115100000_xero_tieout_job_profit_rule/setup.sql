-- Prerequisites for 20261115100000_xero_tieout_job_profit_rule. Earlier registered cases supply everything the
-- migration reads: the tie-out as 20261030060000 left it, Job Profit's cost view, and the stand-in table for
-- bookkeeping's current line evidence (20261104063000's setup). This case adds nothing. Fail closed, by name, if
-- any of it is gone.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.xero_invoices', 'public.materials_reconciliation_queue', 'public.jobs',
                           'public.v_job_cost_events', 'public.v_bookkeeping_line_evidence_current',
                           'public.v_supplier_credit_placement', 'public.xero_bank_transactions'] LOOP
    IF to_regclass(t) IS NULL THEN
      RAISE EXCEPTION 'xero tie-out job profit rule setup: % missing from the registered stack', t;
    END IF;
  END LOOP;
  IF to_regprocedure('public.xero_tieout_monthly(date,integer,uuid)') IS NULL
     OR COALESCE(obj_description('public.xero_tieout_monthly(date,integer,uuid)'::regprocedure, 'pg_proc'), '')
        NOT LIKE 'TP-01 Xero tie-out (20261029121500), supplier credit notes TP-07 (20261030060000)%' THEN
    RAISE EXCEPTION 'xero tie-out job profit rule setup: the tie-out is not 20261030060000''s before the migration';
  END IF;
END $$;
