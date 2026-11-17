DO $break$ DECLARE d text:=pg_get_functiondef('public.job_profit_refresh_many(uuid[])'::regprocedure); BEGIN
 EXECUTE replace(d,'''pg_temp.job_profit_refresh_cost''','''public.v_job_cost_events''');
END $break$;
