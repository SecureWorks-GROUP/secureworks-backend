-- False completion of partial work in the actual tick, isolated fixtures only.
DO $$ DECLARE d text; BEGIN
 d:=pg_get_functiondef('public.context_email_sweep_tick()'::regprocedure);
 d:=replace(d,'r.status=''succeeded''','r.status IN (''succeeded'',''partial'')');
 EXECUTE d;
END $$;
