-- After the down migration: main's body.
DO $$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.persist_trade_work_order_invoice_v1(jsonb,jsonb,uuid)'::regprocedure)
       IS DISTINCT FROM '3c07c3113679ee7cdd99c574f755d99a' THEN
    RAISE EXCEPTION 'work-order split rollback: main body not restored';
  END IF;
END $$;
\ir ../../../migrations/20261118122209_trade_line_hold_work_order_split.sql
\ir ../../../migrations/20261118122209_trade_line_hold_work_order_split.sql
DO $$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.persist_trade_work_order_invoice_v1(jsonb,jsonb,uuid)'::regprocedure)
       IS DISTINCT FROM '7405ac7533156a6e08de5ae94c37c16f' THEN
    RAISE EXCEPTION 'work-order split rollback: re-apply did not restore the post-image';
  END IF;
END $$;
