-- After the down: the old checks, bodies and no switch or start date.
DO $$
BEGIN
  IF to_regclass('public.trade_super_inclusive_settings') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback did not drop the start date table';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'trade_super_inclusive_v1') THEN
    RAISE EXCEPTION 'rollback did not remove the switch';
  END IF;
  IF position('super_basis' IN pg_get_functiondef('public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)'::regprocedure)) > 0
     OR position('super_basis' IN pg_get_functiondef('public.persist_trade_work_order_invoice_v1(jsonb,jsonb,uuid)'::regprocedure)) > 0
     OR position('group_split_super_inclusive_invoice' IN pg_get_functiondef('public.unfreeze_group_work_order_split(uuid,uuid)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'rollback did not restore the function bodies';
  END IF;
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'trade_invoices_super_basis_check')) LIKE '%super_inclusive_v1%' THEN
    RAISE EXCEPTION 'rollback did not restore the basis check';
  END IF;
END $$;
