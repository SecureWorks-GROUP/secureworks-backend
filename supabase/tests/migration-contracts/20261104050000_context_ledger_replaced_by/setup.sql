-- The registered ledger store supplies the runs, generations, items, transitions and the write; no substitute.
DO $$ BEGIN
 IF to_regprocedure('public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)') IS NULL
 OR to_regclass('public.context_ledger_transitions') IS NULL
 OR to_regclass('public.context_ledger_items') IS NULL THEN
  RAISE EXCEPTION 'replaced by prerequisites missing';
 END IF;
END $$;
