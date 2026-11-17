DO $$ BEGIN IF to_regprocedure('public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)') IS NULL THEN RAISE EXCEPTION 'weekly persist prerequisite missing'; END IF; END $$;
