DO $$ BEGIN
  IF to_regprocedure('public.trade_send_totals(uuid)') IS NOT NULL
     OR to_regprocedure('public.install_trade_line_hold()') IS NOT NULL
     OR to_regclass('public.not_job_work_types') IS NOT NULL
     OR to_regclass('public.trade_held_line_notes') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'trade_invoices'
         AND column_name IN ('invoice_kind','send_id','follows_invoice_id')) THEN
    RAISE EXCEPTION 'ZZTEST held-pay rollback left new surfaces';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'trade_invoice_lines'
        AND column_name IN ('hold_reason','held_at','office_review_status')) <> 3 THEN
    RAISE EXCEPTION 'ZZTEST held-pay rollback removed prerequisite columns';
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.trade_invoice_lines'::regclass
        AND conname = 'trade_invoice_lines_hold_reason_check') THEN
    RAISE EXCEPTION 'ZZTEST held-pay rollback removed the prerequisite reason guard';
  END IF;
END $$;
