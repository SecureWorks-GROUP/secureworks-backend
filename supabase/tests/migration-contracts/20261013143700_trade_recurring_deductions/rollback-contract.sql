-- Runs after supabase/rollbacks/20261013143700_trade_recurring_deductions_down.sql
-- against the exact forward stack it reverses.
--
-- The down takes back the surface (the stamping persist) and must keep the
-- record: the rule rows, what an invoice carries and both guards stay, and
-- v1 and v2 are untouched.
BEGIN;

DO $$
DECLARE
  kept integer;
  v_rule uuid;
BEGIN
  IF to_regprocedure('public.persist_weekly_trade_invoice_v3(jsonb, jsonb, uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'the down migration left the stamping persist';
  END IF;
  IF to_regprocedure('public.persist_weekly_trade_invoice_v2(jsonb, jsonb, uuid)') IS NULL
     OR to_regprocedure('public.persist_weekly_trade_invoice_v1(jsonb, jsonb, uuid)') IS NULL THEN
    RAISE EXCEPTION 'the down migration removed a persist it never owned';
  END IF;

  SELECT count(*) INTO kept
  FROM public.trade_recurring_deductions
  WHERE user_id = '1de0c710-0000-4000-8000-000000000001';
  IF kept <> 2 THEN
    RAISE EXCEPTION 'the down migration dropped the Ute hire rows (% of 2 kept)', kept;
  END IF;

  SELECT count(*) INTO kept
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'trade_invoices'
    AND column_name IN ('recurring_deduction_id', 'recurring_deduction_label',
                        'recurring_deduction_amount', 'recurring_deduction_note');
  IF kept <> 4 THEN
    RAISE EXCEPTION 'the down migration dropped what an invoice carries (% of 4 columns kept)', kept;
  END IF;

  -- what an invoice carried is still stored, and still held to its rules
  SELECT id INTO v_rule FROM public.trade_recurring_deductions
  WHERE user_id = '1de0c710-0000-4000-8000-000000000001' AND first_week_start = '2026-10-12';
  INSERT INTO public.trade_invoices (
    id, org_id, user_id, week_start, week_end, status, invoice_source,
    subtotal_ex, gst, total_inc, gst_on, super_rate, super_amount, gross_earned, net_pay,
    recurring_deduction_id, recurring_deduction_label, recurring_deduction_amount
  ) VALUES (
    '2de0c710-0000-4000-8000-0000000000d1', 'f0000000-0000-4000-8000-0000000000aa',
    '1de0c710-0000-4000-8000-000000000001', '2026-10-12', '2026-10-18', 'approved', 'hourly',
    1000, 0, 1000, false, 0.12, 120, 1000, 940, v_rule, 'Ute hire', 100
  );
  BEGIN
    INSERT INTO public.trade_invoices (
      id, org_id, user_id, week_start, week_end, status, invoice_source,
      subtotal_ex, gst, total_inc, gst_on, super_rate, super_amount, gross_earned, net_pay,
      recurring_deduction_id, recurring_deduction_label, recurring_deduction_amount
    ) VALUES (
      '2de0c710-0000-4000-8000-0000000000d2', 'f0000000-0000-4000-8000-0000000000aa',
      '1de0c710-0000-4000-8000-000000000001', '2026-10-12', '2026-10-18', 'approved', 'hourly',
      1000, 0, 1000, false, 0.12, 120, 1000, 940, v_rule, 'Ute hire', 100
    );
    RAISE EXCEPTION 'the down migration dropped the once-per-week guard';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  BEGIN
    INSERT INTO public.trade_invoices (
      id, org_id, user_id, week_start, week_end, status, invoice_source,
      subtotal_ex, gst, total_inc, gst_on, super_rate, super_amount, gross_earned, net_pay,
      recurring_deduction_id, recurring_deduction_label, recurring_deduction_amount
    ) VALUES (
      '2de0c710-0000-4000-8000-0000000000d3', 'f0000000-0000-4000-8000-0000000000aa',
      '1de0c710-0000-4000-8000-000000000001', '2026-10-19', '2026-10-25', 'approved', 'hourly',
      50, 0, 50, false, 0.12, 6, 50, 47, v_rule, 'Ute hire', 100
    );
    RAISE EXCEPTION 'the down migration dropped the never-above-the-payable check';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END;
$$;

ROLLBACK;
