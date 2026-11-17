-- The registered stack supplies the real save, group snapshot and receipt guard.
DO $$ BEGIN
  IF to_regprocedure('public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)') IS NULL
     OR to_regprocedure('public.trade_invoice_lines_group_share_snapshot()') IS NULL
     OR to_regprocedure('public.install_trade_invoice_reimbursement_guard()') IS NULL THEN
    RAISE EXCEPTION 'FU17 reimbursement and group prerequisites missing';
  END IF;
END $$;
