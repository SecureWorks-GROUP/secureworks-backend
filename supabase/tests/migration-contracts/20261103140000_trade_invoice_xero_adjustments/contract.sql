-- Group WO V10. A crew bill's Xero total and the office's changes are unknown
-- (NULL) until read, are written together, and the recorded total is always
-- exactly its named lines. Values are the real Xero bill of
-- SW-INV-A-261011-029 (Alyx, 11 Oct 2026): app net pay 1438.20, Xero total
-- 1338.20 after the office's "Vehicle Loan repayment" -100.00 on account 611.
-- Synthetic records only; every fixture write is rolled back.
BEGIN;
DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  crew uuid := 'f1030000-0000-4000-8000-00000000000a';
  inv uuid;
  got record;
BEGIN
  INSERT INTO public.users(id, org_id, name, role)
    VALUES (crew, org, 'Alyx Synthetic', 'crew')
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.trade_invoices(org_id, user_id, status, subtotal_ex, gross_earned, gst, total_inc, gst_on, super_rate, super_amount, net_pay, invoice_number)
    VALUES (org, crew, 'pushed_to_xero', 1530.00, 1530.00, 0, 1530.00, false, 0.12, 183.60, 1438.20, 'SYN-V10-A-261011-029')
    RETURNING id INTO inv;

  -- 1. Not read yet: unknown, never 0.
  SELECT xero_bill_total, xero_adjustments_ex, xero_adjustment_lines INTO got
    FROM public.trade_invoices WHERE id = inv;
  IF got.xero_bill_total IS NOT NULL OR got.xero_adjustments_ex IS NOT NULL OR got.xero_adjustment_lines IS NOT NULL THEN
    RAISE EXCEPTION 'an unread crew bill reads as known: % % %', got.xero_bill_total, got.xero_adjustments_ex, got.xero_adjustment_lines;
  END IF;

  -- 2. The real bill: the office's line is stored, named, and the app's pay
  --    less it is what Xero pays.
  UPDATE public.trade_invoices SET
    xero_bill_total = 1338.20,
    xero_adjustments_ex = -100.00,
    xero_adjustment_lines = '[{"description":"Vehicle Loan repayment","amount":-100,"account_code":"611","kind":"office_line"}]'::jsonb
  WHERE id = inv;
  SELECT net_pay + gst + xero_adjustments_ex AS paid, xero_bill_total, xero_adjustment_lines -> 0 ->> 'description' AS named
    INTO got FROM public.trade_invoices WHERE id = inv;
  IF got.paid <> 1338.20 OR got.xero_bill_total <> 1338.20 OR got.named <> 'Vehicle Loan repayment' THEN
    RAISE EXCEPTION 'the real Xero reading did not store as read: % % %', got.paid, got.xero_bill_total, got.named;
  END IF;

  -- 3. A total its lines do not explain is refused.
  BEGIN
    UPDATE public.trade_invoices SET xero_adjustments_ex = -50.00 WHERE id = inv;
    RAISE EXCEPTION 'a Xero change total its lines do not explain was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 4. Half a reading is refused: all three or none.
  BEGIN
    UPDATE public.trade_invoices SET xero_adjustment_lines = NULL WHERE id = inv;
    RAISE EXCEPTION 'a Xero reading without its lines was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 5. Every line is named.
  BEGIN
    UPDATE public.trade_invoices SET
      xero_adjustment_lines = '[{"description":" ","amount":-100,"account_code":"611","kind":"office_line"}]'::jsonb
    WHERE id = inv;
    RAISE EXCEPTION 'a Xero change without a name was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 6. A difference no line names is kept as its own entry, with no account
  --    (SW-INV-I-260828-006: app 1943.22, Xero 1735.01, no extra line).
  UPDATE public.trade_invoices SET
    xero_bill_total = 1229.99,
    xero_adjustments_ex = -208.21,
    xero_adjustment_lines = '[{"description":"Difference on the Xero bill with no line of its own","amount":-208.21,"account_code":null,"kind":"unexplained"}]'::jsonb
  WHERE id = inv;

  -- 7. Read, none: 0 with no lines.
  UPDATE public.trade_invoices SET xero_bill_total = 1438.20, xero_adjustments_ex = 0, xero_adjustment_lines = '[]'::jsonb
  WHERE id = inv;

  -- 8. Back to unknown is allowed (a bill that can no longer be read).
  UPDATE public.trade_invoices SET xero_bill_total = NULL, xero_adjustments_ex = NULL, xero_adjustment_lines = NULL
  WHERE id = inv;
END $$;
ROLLBACK;
