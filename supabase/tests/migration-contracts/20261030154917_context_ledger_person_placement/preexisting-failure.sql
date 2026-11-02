DO $$ DECLARE d text; BEGIN
 SELECT pg_get_functiondef('public.context_ledger_evidence_rows(uuid[],timestamptz)'::regprocedure) INTO d;
 EXECUTE replace(d,' WITH j AS (',' -- unexpected prior reader definition
 WITH j AS (');
END $$;
