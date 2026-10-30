DO $$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ledger_judge(uuid[])'::regprocedure) <> '2483ad58fdea93abcb1ca5f4d87658ee' OR to_regprocedure('public.context_ledger_record_signature(uuid)') IS NOT NULL OR to_regprocedure('public.context_ledger_record_packet(uuid,timestamptz)') IS NOT NULL THEN RAISE EXCEPTION 'financial refresh rollback mismatch'; END IF;
END $$;
