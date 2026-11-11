-- The registered stack supplies users, trade invoices, the invoice-line guard
-- and the weekly persist functions.
DO $$ BEGIN
  IF to_regprocedure('public.trade_invoice_lines_group_share_snapshot()') IS NULL
     OR to_regprocedure('public.persist_weekly_trade_invoice_v3(jsonb,jsonb,uuid)') IS NULL
     OR to_regclass('public.trade_invoices') IS NULL THEN
    RAISE EXCEPTION 'trade super-on-top prerequisites are missing';
  END IF;
END $$;
