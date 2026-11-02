-- The registered stack supplies the group fence, job work orders and allocations.
DO $$ BEGIN
  IF to_regprocedure('public.group_work_order_line_is_normal_pay(text,uuid)') IS NULL
     OR to_regprocedure('public.trade_invoice_lines_group_share_snapshot()') IS NULL
     OR to_regclass('public.job_assignments') IS NULL THEN
    RAISE EXCEPTION 'patio auto-group prerequisites are missing';
  END IF;
END $$;
