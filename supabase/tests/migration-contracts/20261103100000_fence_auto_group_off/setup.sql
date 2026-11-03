-- The registered stack supplies the WO-6 patio auto-group (flag, office-fee
-- helper, v_patio_group_coverage), the group fence, job work orders and
-- allocations.
DO $$ BEGIN
  IF to_regprocedure('public.group_work_order_line_is_normal_pay(text,uuid)') IS NULL
     OR to_regprocedure('public.group_work_order_line_is_office_fee(text,text)') IS NULL
     OR to_regprocedure('public.job_work_order_open_statuses()') IS NULL
     OR to_regclass('public.v_patio_group_coverage') IS NULL
     OR to_regclass('public.job_assignments') IS NULL THEN
    RAISE EXCEPTION 'fence auto-group prerequisites are missing';
  END IF;
END $$;
