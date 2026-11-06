-- The registered stack supplies the group tables, the one crew population,
-- the split, the release check and the pay fences this migration amends.
DO $$ BEGIN
  IF to_regprocedure('public.group_work_order_write_split(uuid,boolean)') IS NULL
     OR to_regprocedure('public.group_work_order_release_state(uuid)') IS NULL
     OR to_regprocedure('public.group_work_order_crew(uuid[])') IS NULL
     OR to_regprocedure('public.group_work_orders_refuse_existing_pay()') IS NULL
     OR to_regprocedure('public.trade_invoice_lines_group_share_snapshot()') IS NULL
     OR to_regprocedure('public.group_work_order_budget_lock()') IS NULL
     OR to_regprocedure('public.group_work_order_line_is_normal_pay(text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'group paid-by-hours prerequisites are missing';
  END IF;
END $$;
