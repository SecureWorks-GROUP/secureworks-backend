-- After the down migration: main's body.
DO $$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.persist_trade_work_order_invoice_v1(jsonb,jsonb,uuid)'::regprocedure)
       IS DISTINCT FROM '3c07c3113679ee7cdd99c574f755d99a' THEN
    RAISE EXCEPTION 'work-order split rollback: main body not restored';
  END IF;
END $$;
\ir ../../../migrations/20261118063200_trade_line_hold_work_order_split.sql
\ir ../../../migrations/20261118063200_trade_line_hold_work_order_split.sql
DO $$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.persist_trade_work_order_invoice_v1(jsonb,jsonb,uuid)'::regprocedure)
       IS DISTINCT FROM '87f0d8ce6b3e090105b011e8962017ea' THEN
    RAISE EXCEPTION 'work-order split rollback: re-apply did not restore the post-image';
  END IF;
END $$;
