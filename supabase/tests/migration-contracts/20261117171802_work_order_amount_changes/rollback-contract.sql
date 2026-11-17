DO $$ BEGIN IF to_regclass('public.work_order_amount_changes') IS NOT NULL THEN RAISE EXCEPTION 'change rollback incomplete'; END IF; END $$;
