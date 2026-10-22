-- After the down migration the H7 view is gone and the 1107 surfaces it reads
-- are untouched.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF to_regclass('public.cfo_bill_reconciliation_outcomes') IS NOT NULL THEN
    RAISE EXCEPTION 'h7 rollback: view survived';
  END IF;
  IF to_regclass('public.v_bill_allocation_balance') IS NULL
     OR to_regprocedure('public.allocate_bill_split(text, jsonb, numeric, text, text)') IS NULL THEN
    RAISE EXCEPTION 'h7 rollback: 1107 surfaces lost';
  END IF;
END $$;
