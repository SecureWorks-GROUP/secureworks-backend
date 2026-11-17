DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'trade_invoice_lines' AND column_name = 'expense_receipt_id') THEN RAISE EXCEPTION 'ZZTEST receipt column survived rollback'; END IF;
  IF strpos(pg_get_viewdef('public.v_trade_charge_resolved'::regclass, true), '''reimbursement''::text') > 0 THEN RAISE EXCEPTION 'ZZTEST reimbursement lane survived rollback'; END IF;
END $$;
