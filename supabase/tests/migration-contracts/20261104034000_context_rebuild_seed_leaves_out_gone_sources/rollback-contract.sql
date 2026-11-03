-- After the undo the packet is the old definition again: a carried note whose source is gone refuses the rebuild.
DO $$ BEGIN
 IF md5(pg_get_functiondef('public.context_ledger_rebuild_packet(uuid,uuid)'::regprocedure)) <> '24a300377b1e4f4c01f36fda9b2099c8' THEN
  RAISE EXCEPTION 'rebuild seed rollback: not the old definition (md5 %)', md5(pg_get_functiondef('public.context_ledger_rebuild_packet(uuid,uuid)'::regprocedure));
 END IF;
END $$;
