-- After the rollback: the rule and its index are gone and the 20261118195100
-- twin body is back (its own exact, org-scoped match), settings kept.
DO $$
DECLARE src text;
BEGIN
  IF to_regprocedure('public.trade_invoice_bill_mirror_verdicts(uuid,text[])') IS NOT NULL THEN
    RAISE EXCEPTION 'mirror rule rollback: the function is still there'; END IF;
  IF to_regclass('public.trade_invoices_xero_bill_key_idx') IS NOT NULL THEN
    RAISE EXCEPTION 'mirror rule rollback: the index is still there'; END IF;
  SELECT prosrc INTO src FROM pg_proc
   WHERE oid = 'public.job_cost_lines_backfill_bills(uuid,date,date,integer,date,text)'::regprocedure
     AND 'lock_timeout=5s' = ANY (proconfig);
  IF src IS NULL OR src LIKE '%mirror_verdicts%' OR src NOT LIKE '%t.xero_bill_id = x.xero_invoice_id%' THEN
    RAISE EXCEPTION 'mirror rule rollback: the twin body was not restored'; END IF;
END;
$$;
