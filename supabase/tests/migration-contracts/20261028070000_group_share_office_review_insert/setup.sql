-- The normal registered stack supplies the complete invoice, group and
-- weekly persistence surfaces. Do not replace them with a minimal table.
DO $$ BEGIN
  IF to_regprocedure('public.persist_weekly_trade_invoice_v3(jsonb,jsonb,uuid)') IS NULL
     OR to_regprocedure('public.freeze_group_work_order_split(uuid)') IS NULL
     OR to_regclass('public.job_client_signoffs') IS NULL THEN
    RAISE EXCEPTION 'group office-review contract prerequisites are missing';
  END IF;
END $$;
