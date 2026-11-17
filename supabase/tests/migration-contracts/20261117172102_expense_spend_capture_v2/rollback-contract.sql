DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name = 'expense_receipts' AND column_name IN ('stock_division', 'capture_version')) THEN
    RAISE EXCEPTION 'receipt capture columns remain after rollback';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name IN ('spend_capture_v2', 'inbox_link_v1')) THEN
    RAISE EXCEPTION 'off switches remain after rollback';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name = 'trade_invoice_lines' AND column_name = 'expense_receipt_id') THEN
    RAISE EXCEPTION 'shared reimbursement links were removed';
  END IF;
END $$;
