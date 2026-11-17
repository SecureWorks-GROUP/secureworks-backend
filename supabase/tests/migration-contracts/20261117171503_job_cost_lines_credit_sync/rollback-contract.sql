DO $$ BEGIN
 IF to_regprocedure('public.job_cost_lines_sync_credit_notes(text[])') IS NOT NULL
   OR to_regclass('public.xero_supplier_credit_notes') IS NULL THEN RAISE EXCEPTION 'credit sync rollback failed'; END IF;
END $$;
