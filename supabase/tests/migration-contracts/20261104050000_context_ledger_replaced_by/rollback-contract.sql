-- After the undo the write is the 20261007150000 definition again, word for word with its comment, and the new guard,
-- column and check are gone.
DO $$ BEGIN
 IF md5(pg_get_functiondef('public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)'::regprocedure)) <> 'bfe7aa27a44451a235af4da10004f61a'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)'::regprocedure) <> '6da1007ff2a6331219f4d98f85749ca7' THEN
  RAISE EXCEPTION 'replaced by rollback: not the old definition (md5 %)', md5(pg_get_functiondef('public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)'::regprocedure));
 END IF;
 IF md5(obj_description('public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)'::regprocedure, 'pg_proc')) <> '25b1fb7a0275b17e0d62181672f83934' THEN
  RAISE EXCEPTION 'replaced by rollback: not the old comment';
 END IF;
 IF to_regprocedure('public.context_ledger_same_loop(public.context_ledger_items,public.context_ledger_items)') IS NOT NULL
 OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.context_ledger_transitions'::regclass AND attname = 'replaced_by_key' AND NOT attisdropped)
 OR EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'context_ledger_transitions_replaced_by_key_check') THEN
  RAISE EXCEPTION 'replaced by rollback: the guard, column or check is still there';
 END IF;
 IF NOT has_function_privilege('service_role', 'public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)', 'EXECUTE')
 OR has_function_privilege('anon', 'public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)', 'EXECUTE') THEN
  RAISE EXCEPTION 'replaced by rollback: the write lost its grants';
 END IF;
END $$;
