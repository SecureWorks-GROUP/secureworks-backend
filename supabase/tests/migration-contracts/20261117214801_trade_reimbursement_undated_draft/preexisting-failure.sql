DO $$ DECLARE d text; BEGIN
 d := pg_get_functiondef('public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)'::regprocedure);
 EXECUTE replace(d, E'\nDECLARE\n', E'\n-- ZZTEST unexpected body change\nDECLARE\n');
END $$;
