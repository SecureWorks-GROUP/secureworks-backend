DO $$ BEGIN
 IF to_regprocedure('public.context_ledger_rebuild_packet(uuid,uuid)') IS NOT NULL
 OR to_regprocedure('public.context_ledger_packet(uuid,timestamptz,timestamptz)') IS NULL
 OR to_regprocedure('public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)') IS NULL THEN
  RAISE EXCEPTION 'rebuild rollback failed or changed existing consumer APIs';
 END IF;
END $$;
