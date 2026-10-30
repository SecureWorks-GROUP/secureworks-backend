DO $$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.cfo_bill_cost_outcomes_scoped(uuid)'::regprocedure) IS DISTINCT FROM 'ff29056b9f02874242f5b1f4519a128a' THEN RAISE EXCEPTION 'H7 credit down lost original function'; END IF;
 IF NOT has_function_privilege('service_role','public.cfo_bill_cost_outcomes_scoped(uuid)','EXECUTE') OR has_function_privilege('anon','public.cfo_bill_cost_outcomes_scoped(uuid)','EXECUTE') OR has_function_privilege('authenticated','public.cfo_bill_cost_outcomes_scoped(uuid)','EXECUTE') THEN RAISE EXCEPTION 'H7 credit down changed access';END IF;
END $$;
