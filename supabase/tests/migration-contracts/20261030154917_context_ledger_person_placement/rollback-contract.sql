DO $$
DECLARE h text;
BEGIN
 SELECT md5(prosrc) INTO h FROM pg_proc WHERE oid='public.context_ledger_cite(uuid,jsonb)'::regprocedure; IF h IS DISTINCT FROM '44b8faee5207fa4a4604dbcb25cbfc12' THEN RAISE EXCEPTION 'reader placement rollback did not restore context_ledger_cite(uuid,jsonb)'; END IF;
 SELECT md5(prosrc) INTO h FROM pg_proc WHERE oid='public.context_ledger_row_elsewhere(uuid,text,uuid)'::regprocedure; IF h IS DISTINCT FROM '3db4825169011625b6eadf2a2cc288af' THEN RAISE EXCEPTION 'reader placement rollback did not restore context_ledger_row_elsewhere(uuid,text,uuid)'; END IF;
 SELECT md5(prosrc) INTO h FROM pg_proc WHERE oid='public.context_ledger_evidence_rows(uuid[],timestamp with time zone)'::regprocedure; IF h IS DISTINCT FROM 'f660fe3e9484200448b451cfa5f33d64' THEN RAISE EXCEPTION 'reader placement rollback did not restore context_ledger_evidence_rows(uuid[],timestamp with time zone)'; END IF;
 IF to_regprocedure('public.context_ledger_reader_events(uuid[])') IS NOT NULL THEN RAISE EXCEPTION 'reader placement rollback left projection'; END IF;
 SELECT md5(prosrc) INTO h FROM pg_proc WHERE oid='public.context_ledger_held_rows(uuid[],timestamptz)'::regprocedure; IF h IS DISTINCT FROM 'df1971a701be94dec3900448b3b53c69' THEN RAISE EXCEPTION 'held rows rollback mismatch'; END IF;
END $$;
