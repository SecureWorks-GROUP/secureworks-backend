DO $$ DECLARE s text; BEGIN SELECT pg_get_functiondef('context_ledger_judge(uuid[])'::regprocedure) INTO s; EXECUTE replace(s,'WITH s AS (','WITH s AS ( /* unexpected prior version */'); END $$;
