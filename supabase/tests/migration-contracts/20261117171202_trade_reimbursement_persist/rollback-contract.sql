DO $$ BEGIN
  IF strpos(pg_get_functiondef('public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)'::regprocedure), 'line_position, expense_receipt_id, office_review_status, office_review_note') > 0 THEN RAISE EXCEPTION 'ZZTEST receipt persistence survived rollback'; END IF;
END $$;
