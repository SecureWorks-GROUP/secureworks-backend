-- Unsafe variant: move original customer identity with the evidence.
DO $$ DECLARE d text; BEGIN
 SELECT pg_get_functiondef('public.context_ledger_event_on_job(public.business_events,uuid)'::regprocedure) INTO d;
 IF position('IF same_customer IS DISTINCT FROM true THEN' in d)=0 THEN RAISE EXCEPTION 'fault anchor missing'; END IF;
 EXECUTE replace(d,'IF same_customer IS DISTINCT FROM true THEN','IF false THEN');
END $$;
