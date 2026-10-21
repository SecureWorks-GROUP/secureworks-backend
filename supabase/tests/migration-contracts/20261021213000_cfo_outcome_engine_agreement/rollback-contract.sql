-- After the down migration the view is 20261021173000's again: no
-- held_reason column, and still readable.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF to_regclass('public.cfo_bill_reconciliation_outcomes') IS NULL THEN
    RAISE EXCEPTION 'engine agreement rollback: the view was lost';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'cfo_bill_reconciliation_outcomes'
                AND column_name = 'held_reason')
     OR position('hold_reason' IN pg_get_viewdef('public.cfo_bill_reconciliation_outcomes'::regclass)) > 0 THEN
    RAISE EXCEPTION 'engine agreement rollback: the hold survived';
  END IF;
  IF position('cfo_recorded_person' IN pg_get_viewdef('public.cfo_bill_reconciliation_outcomes'::regclass)) = 0 THEN
    RAISE EXCEPTION 'engine agreement rollback: the 20261021173000 body was not restored';
  END IF;
  PERFORM 1 FROM public.cfo_bill_reconciliation_outcomes LIMIT 1;
END $$;
