DO $$ DECLARE d text:=pg_get_functiondef('public.cfo_bill_cost_outcomes_scoped(uuid)'::regprocedure);BEGIN EXECUTE replace(d,'FROM judged j','FROM judged j /* foreign newer owner body */');END $$;
