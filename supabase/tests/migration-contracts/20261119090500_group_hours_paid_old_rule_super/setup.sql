-- The registered stack supplies the group tables, the split, the release
-- check and 20261106160000's hours-paid functions this migration amends.
DO $$ BEGIN
  IF to_regprocedure('public.group_work_order_hours_paid_total(uuid,text)') IS NULL
     OR to_regprocedure('public.group_work_order_hours_paid(uuid)') IS NULL
     OR to_regprocedure('public.group_work_order_hours_paid_budget(text,numeric)') IS NULL
     OR to_regprocedure('public.group_work_order_invoice_billed(text,text,text)') IS NULL
     OR to_regprocedure('public.group_work_order_line_is_paid_hours(text,uuid,text)') IS NULL
     OR to_regprocedure('public.group_work_order_write_split(uuid,boolean)') IS NULL
     OR to_regprocedure('public.group_work_order_release_state(uuid)') IS NULL THEN
    RAISE EXCEPTION 'group old-rule hourly super prerequisites are missing';
  END IF;
END $$;
