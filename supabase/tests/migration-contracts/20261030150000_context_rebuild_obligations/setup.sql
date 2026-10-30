-- Use the existing registered ledger store and held-note stack, no substitute.
DO $$ BEGIN
 IF to_regprocedure('public.context_ledger_packet(uuid,timestamptz,timestamptz)') IS NULL
 OR to_regprocedure('public.context_ledger_held_cite(uuid,jsonb)') IS NULL THEN
  RAISE EXCEPTION 'rebuild preservation prerequisites missing';
 END IF;
END $$;
