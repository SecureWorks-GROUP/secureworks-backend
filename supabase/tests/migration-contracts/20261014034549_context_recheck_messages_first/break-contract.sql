-- Invert priority without changing eligibility: the behavior test must catch it.
DO $$ DECLARE ddl text; BEGIN
 SELECT pg_get_functiondef('public.rerun_context_attribution(integer,text)'::regprocedure) INTO ddl;
 EXECUTE replace(ddl, ') THEN 0 ELSE 1 END,', ') THEN 1 ELSE 0 END,');
END $$;
