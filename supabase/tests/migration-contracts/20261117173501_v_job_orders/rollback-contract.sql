DO $$ BEGIN IF to_regclass('public.v_job_orders') IS NOT NULL OR to_regprocedure('public.supplier_name_key(text)') IS NOT NULL THEN RAISE EXCEPTION 'orders: rollback'; END IF; END $$;
