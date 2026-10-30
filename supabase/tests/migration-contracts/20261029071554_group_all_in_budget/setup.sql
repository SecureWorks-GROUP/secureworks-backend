DO $$ BEGIN
  IF to_regclass('public.group_work_order_events') IS NULL
     OR to_regprocedure('public.trade_invoice_lines_group_share_snapshot()') IS NULL THEN
    RAISE EXCEPTION 'group all-in budget prerequisites are missing';
  END IF;
END $$;
