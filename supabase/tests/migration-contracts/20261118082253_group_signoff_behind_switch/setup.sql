-- P1-13.2: the registered group stack and the sign-off rule must land first.
DO $$ BEGIN
  IF to_regprocedure('public.group_client_signoff_counts(uuid)') IS NULL
     OR to_regprocedure('public.group_work_order_write_split(uuid,boolean)') IS NULL
     OR to_regprocedure('public.trade_invoice_lines_group_share_snapshot()') IS NULL
     OR to_regprocedure('public.group_work_order_release_state(uuid)') IS NULL
     OR to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'ZZTEST P1-13.2 prerequisites missing';
  END IF;
END $$;
