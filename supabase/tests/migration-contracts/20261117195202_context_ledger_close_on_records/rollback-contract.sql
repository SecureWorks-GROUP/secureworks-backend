DO $c$ BEGIN IF to_regprocedure('public.context_ledger_close_on_records(uuid,boolean)') IS NOT NULL THEN RAISE EXCEPTION 'record close rollback left function'; END IF; END $c$;
