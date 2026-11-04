-- After the down: the fence counts office fees as pay again; the helper, the
-- view and the flag are gone.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF to_regprocedure('public.group_work_order_line_is_office_fee(text,text)') IS NOT NULL
     OR to_regclass('public.v_patio_group_coverage') IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name='group_work_order_auto_patio_v1') THEN
    RAISE EXCEPTION 'rollback left WO-6 objects behind';
  END IF;
  IF pg_get_functiondef('public.trade_invoice_lines_group_share_snapshot()'::regprocedure) LIKE '%office_fee%'
     OR pg_get_functiondef('public.group_work_orders_refuse_existing_pay()'::regprocedure) LIKE '%office_fee%' THEN
    RAISE EXCEPTION 'rollback left the office-fee exception in the fence';
  END IF;
END $$;
