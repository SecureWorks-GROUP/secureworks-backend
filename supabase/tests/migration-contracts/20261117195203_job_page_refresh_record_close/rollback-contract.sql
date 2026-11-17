DO $c$ BEGIN
 IF to_regprocedure('public.context_ledger_record_close_install()') IS NOT NULL OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='context_ledger_record_close_withdraw') THEN RAISE EXCEPTION 'refresh record close rollback left installer or trigger'; END IF;
 IF position('record_close' IN pg_get_functiondef('public.job_page_refresh(uuid)'::regprocedure))>0 THEN RAISE EXCEPTION 'refresh record close rollback did not restore prior body'; END IF;
END $c$;
