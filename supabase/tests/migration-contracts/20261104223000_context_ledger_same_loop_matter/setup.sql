-- The registered ledger store (20261104050000) supplies context_ledger_items and context_ledger_same_loop; no substitute.
DO $$ BEGIN
 IF to_regclass('public.context_ledger_items') IS NULL
 OR to_regprocedure('public.context_ledger_same_loop(public.context_ledger_items,public.context_ledger_items)') IS NULL THEN
  RAISE EXCEPTION 'same loop matter prerequisites missing';
 END IF;
END $$;
