DO $$
BEGIN
  IF to_regclass('public.xero_draft_register') IS NOT NULL
     OR to_regclass('public.bookkeeping_checks') IS NOT NULL THEN
    RAISE EXCEPTION 'register rollback left a table';
  END IF;
END $$;
