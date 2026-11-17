BEGIN;
-- Isolate this contract from unrelated invoice requirements in the registered stack.
-- Keep the new receipt FK, its unique rule and the receipt checks under test.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.trade_invoice_lines'::regclass AND contype IN ('f', 'c')
      AND NOT (contype = 'f' AND confrelid = 'public.expense_receipts'::regclass) LOOP
    EXECUTE format('ALTER TABLE public.trade_invoice_lines DROP CONSTRAINT %I', r.conname);
  END LOOP;
  FOR r IN SELECT attname FROM pg_attribute
    WHERE attrelid = 'public.trade_invoice_lines'::regclass
      AND attnum > 0 AND NOT attisdropped AND attnotnull AND attname <> 'id' LOOP
    EXECUTE format('ALTER TABLE public.trade_invoice_lines ALTER COLUMN %I DROP NOT NULL', r.attname);
  END LOOP;
  FOR r IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.expense_receipts'::regclass AND contype = 'f' LOOP
    EXECUTE format('ALTER TABLE public.expense_receipts DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE public.trade_invoice_lines DISABLE TRIGGER USER;

DO $$
DECLARE receipt uuid; seen_constraint text;
BEGIN
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'spend_capture_v2') IS DISTINCT FROM false
     OR (SELECT enabled FROM public.feature_flags WHERE flag_name = 'inbox_link_v1') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'receipt capture switches must start off';
  END IF;
  INSERT INTO public.expense_receipts (receipt_photo_url) VALUES ('ZZTEST-receipt') RETURNING id INTO receipt;
  IF NOT EXISTS (SELECT 1 FROM public.expense_receipts WHERE id = receipt
    AND job_id IS NULL AND stock_division IS NULL AND capture_version IS NULL) THEN
    RAISE EXCEPTION 'old-style receipt must still insert';
  END IF;
  BEGIN
    INSERT INTO public.expense_receipts (receipt_photo_url, stock_division) VALUES ('ZZTEST-invalid', 'roofing');
    RAISE EXCEPTION 'invalid stock division accepted';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS seen_constraint = CONSTRAINT_NAME;
    IF seen_constraint <> 'expense_receipts_stock_division_check' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO public.expense_receipts (receipt_photo_url, job_id, stock_division)
    VALUES ('ZZTEST-both', gen_random_uuid(), 'patios');
    RAISE EXCEPTION 'job and stock division accepted together';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS seen_constraint = CONSTRAINT_NAME;
    IF seen_constraint <> 'expense_receipts_job_or_stock_not_both' THEN RAISE; END IF;
  END;
  INSERT INTO public.expense_receipts (receipt_photo_url, stock_division, capture_version)
    SELECT 'ZZTEST-stock', division, 2 FROM unnest(ARRAY['patios','fencing','insurance']) division;
  INSERT INTO public.trade_invoice_lines (expense_receipt_id) VALUES (receipt);
  BEGIN
    INSERT INTO public.trade_invoice_lines (expense_receipt_id) VALUES (receipt);
    RAISE EXCEPTION 'duplicate reimbursement accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.trade_invoice_lines (expense_receipt_id) VALUES (gen_random_uuid());
    RAISE EXCEPTION 'missing receipt accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  INSERT INTO public.trade_invoice_lines (expense_receipt_id) VALUES (NULL), (NULL);
END $$;
SELECT 'PASS: P2-06.1 receipt constraints, reimbursement uniqueness and off switches' AS result;
ROLLBACK;
