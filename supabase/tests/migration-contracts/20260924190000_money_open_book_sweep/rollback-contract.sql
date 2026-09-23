-- After the MN1 rollback: the F1b stub is back (null block, F1b comment), the
-- two new functions are gone, the composer answers with money null, and the
-- xero_verified_at column stays (the deployed xero-sync writes it; see the
-- down migration).
DO $$
BEGIN
 IF public.context_money_status() IS NOT NULL THEN RAISE EXCEPTION 'mn1 rollback: stub not restored'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_money_status()'))<>'155104bfb08b8b3c2f98bdec089d4ee4'
 THEN RAISE EXCEPTION 'mn1 rollback: stub body'; END IF;
 IF obj_description('public.context_money_status()'::regprocedure,'pg_proc') NOT LIKE 'F1b stub.%' THEN RAISE EXCEPTION 'mn1 rollback: stub comment'; END IF;
 IF has_function_privilege('anon','public.context_money_status()','EXECUTE') OR has_function_privilege('authenticated','public.context_money_status()','EXECUTE')
 THEN RAISE EXCEPTION 'mn1 rollback: stub grants'; END IF;
 IF to_regprocedure('public.context_money_policy()') IS NOT NULL OR to_regprocedure('public.context_money_open_book_mode()') IS NOT NULL
 THEN RAISE EXCEPTION 'mn1 rollback: functions left behind'; END IF;
 IF public.context_pipeline_status()->'money'<>'null'::jsonb THEN RAISE EXCEPTION 'mn1 rollback: composer block'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.xero_invoices'::regclass AND attname='xero_verified_at' AND NOT attisdropped)
 THEN RAISE EXCEPTION 'mn1 rollback: xero_verified_at must stay'; END IF;
END $$;
