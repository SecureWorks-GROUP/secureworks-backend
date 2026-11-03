-- The registered ledger store, held notes and rebuild preparation; no substitute.
DO $$ BEGIN
 IF to_regprocedure('public.context_ledger_rebuild_packet(uuid,uuid)') IS NULL
 OR to_regprocedure('public.context_ledger_cite(uuid,jsonb)') IS NULL
 OR to_regprocedure('public.context_ledger_held_cite(uuid,jsonb)') IS NULL THEN
  RAISE EXCEPTION 'rebuild seed prerequisites missing';
 END IF;
END $$;
