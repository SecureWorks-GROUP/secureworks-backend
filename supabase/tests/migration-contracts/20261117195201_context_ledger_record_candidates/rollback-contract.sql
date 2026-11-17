DO $c$ BEGIN IF to_regprocedure('public.context_ledger_record_candidates(uuid,text,text,timestamptz,text)') IS NOT NULL THEN RAISE EXCEPTION 'record close rollback left function'; END IF; END $c$;
