-- Contract for 20261117020000_trade_pay_inclusive_super (P1-01.1).
--
-- One super rule: every amount includes super. The fund gets 12/112 of the
-- total less reimbursements and the person the rest. An invoice priced before
-- keeps its own rule. Made-up ZZTEST records only; every case rolls back.

\set ON_ERROR_STOP on

-- 0. Ships off and empty; browser roles cannot read the settings or call the rule.
DO $$
BEGIN
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'trade_pay_inclusive_super_v1') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'the inclusive super switch must ship off';
  END IF;
  IF (SELECT count(*) FROM public.trade_pay_settings) <> 1
     OR EXISTS (SELECT 1 FROM public.trade_pay_settings
                WHERE inclusive_super_from IS NOT NULL OR tax_set_aside_percent IS NOT NULL
                   OR reimbursement_account_code IS NOT NULL OR pay_run_approver_user_ids <> '{}') THEN
    RAISE EXCEPTION 'trade_pay_settings must ship as one empty row';
  END IF;
  IF has_table_privilege('anon', 'public.trade_pay_settings', 'SELECT')
     OR has_table_privilege('authenticated', 'public.trade_pay_settings', 'SELECT')
     OR has_table_privilege('service_role', 'public.trade_pay_settings', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.trade_pay_settings', 'SELECT') THEN
    RAISE EXCEPTION 'trade_pay_settings privileges are wrong';
  END IF;
  IF has_function_privilege('anon', 'public.trade_pay_rule_on(date)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.trade_pay_rule_on(date)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.trade_pay_rule_on(date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'trade_pay_rule_on privileges are wrong';
  END IF;
END $$;

-- 1. The worked example: total 1,120.00, super 120.00, paid 1,000.00.
BEGIN;
INSERT INTO public.users (id, org_id, name) VALUES
  ('f1170000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000001', 'ZZTEST Crew');
INSERT INTO public.trade_invoices (org_id, user_id, status, subtotal_ex, gross_earned, super_rate, super_amount, net_pay, gst_on, gst, total_inc, super_basis, invoice_number)
VALUES ('00000000-0000-0000-0000-000000000001', 'f1170000-0000-4000-8000-00000000000a', 'pending_acknowledgment',
        1120.00, 1120.00, 0.12, 120.00, 1000.00, false, 0, 1120.00, 'inclusive_12_112_v1', 'ZZTEST-INC-1');
ROLLBACK;

-- 2. Refused: 12% of the total (134.40) on the inclusive rule.
BEGIN;
INSERT INTO public.users (id, org_id, name) VALUES
  ('f1170000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000001', 'ZZTEST Crew');
DO $$
DECLARE refused boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.trade_invoices (org_id, user_id, status, subtotal_ex, gross_earned, super_rate, super_amount, net_pay, gst_on, gst, total_inc, super_basis, invoice_number)
    VALUES ('00000000-0000-0000-0000-000000000001', 'f1170000-0000-4000-8000-00000000000a', 'pending_acknowledgment',
            1120.00, 1120.00, 0.12, 134.40, 985.60, false, 0, 1120.00, 'inclusive_12_112_v1', 'ZZTEST-INC-2');
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'stored 12%% of the total on the inclusive rule'; END IF;
END $$;
ROLLBACK;

-- 3. A reimbursement carries no super, and GST is 10% of the base: gross
--    1,200.00, base 1,120.00, super 120.00, net 1,080.00, GST 112.00,
--    total 1,312.00 accepted. GST of 120.00 (10% of gross) refused.
BEGIN;
INSERT INTO public.users (id, org_id, name) VALUES
  ('f1170000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000001', 'ZZTEST Crew');
INSERT INTO public.trade_invoices (org_id, user_id, status, subtotal_ex, gross_earned, super_base_ex, super_rate, super_amount, net_pay, gst_on, gst, total_inc, super_basis, invoice_number)
VALUES ('00000000-0000-0000-0000-000000000001', 'f1170000-0000-4000-8000-00000000000a', 'pending_acknowledgment',
        1200.00, 1200.00, 1120.00, 0.12, 120.00, 1080.00, true, 112.00, 1312.00, 'inclusive_12_112_v1', 'ZZTEST-INC-3');
DO $$
DECLARE refused boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.trade_invoices (org_id, user_id, status, subtotal_ex, gross_earned, super_base_ex, super_rate, super_amount, net_pay, gst_on, gst, total_inc, super_basis, invoice_number)
    VALUES ('00000000-0000-0000-0000-000000000001', 'f1170000-0000-4000-8000-00000000000a', 'pending_acknowledgment',
            1200.00, 1200.00, 1120.00, 0.12, 120.00, 1080.00, true, 120.00, 1320.00, 'inclusive_12_112_v1', 'ZZTEST-INC-4');
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'stored GST on the reimbursement'; END IF;
END $$;
ROLLBACK;

-- 4. The smallest amounts: 0.14 total, super 0.02 (0.015 rounds up), paid 0.12.
BEGIN;
INSERT INTO public.users (id, org_id, name) VALUES
  ('f1170000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000001', 'ZZTEST Crew');
INSERT INTO public.trade_invoices (org_id, user_id, status, subtotal_ex, gross_earned, super_rate, super_amount, net_pay, gst_on, gst, total_inc, super_basis, invoice_number)
VALUES ('00000000-0000-0000-0000-000000000001', 'f1170000-0000-4000-8000-00000000000a', 'pending_acknowledgment',
        0.14, 0.14, 0.12, 0.02, 0.12, false, 0, 0.14, 'inclusive_12_112_v1', 'ZZTEST-INC-5');
ROLLBACK;

-- 5. An invoice priced before (12/6 split, no basis) is still accepted, and a
--    full employer super share still is.
BEGIN;
INSERT INTO public.users (id, org_id, name) VALUES
  ('f1170000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000001', 'ZZTEST Crew');
INSERT INTO public.trade_invoices (org_id, user_id, status, subtotal_ex, gross_earned, super_rate, super_amount, net_pay, gst_on, gst, total_inc, invoice_number)
VALUES ('00000000-0000-0000-0000-000000000001', 'f1170000-0000-4000-8000-00000000000a', 'pending_acknowledgment',
        1000.00, 1000.00, 0.12, 120.00, 940.00, false, 0, 1000.00, 'ZZTEST-OLD-1');
INSERT INTO public.trade_invoices (org_id, user_id, status, subtotal_ex, gross_earned, super_rate, super_amount, net_pay, gst_on, gst, total_inc, super_basis, invoice_number)
VALUES ('00000000-0000-0000-0000-000000000001', 'f1170000-0000-4000-8000-00000000000a', 'pending_acknowledgment',
        1000.00, 1000.00, 0.12, 120.00, 1000.00, false, 0, 1000.00, 'employer_12_v2', 'ZZTEST-OLD-2');
-- The old rule's GST is still 10% of gross.
INSERT INTO public.trade_invoices (org_id, user_id, status, subtotal_ex, gross_earned, super_rate, super_amount, net_pay, gst_on, gst, total_inc, invoice_number)
VALUES ('00000000-0000-0000-0000-000000000001', 'f1170000-0000-4000-8000-00000000000a', 'pending_acknowledgment',
        1000.00, 1000.00, 0.12, 120.00, 940.00, true, 100.00, 1100.00, 'ZZTEST-OLD-3');
ROLLBACK;

-- 6. More refusals: nothing withheld; half a cent rounded down; the 12/6
--    split stamped inclusive; an unknown basis.
BEGIN;
INSERT INTO public.users (id, org_id, name) VALUES
  ('f1170000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000001', 'ZZTEST Crew');
DO $$
DECLARE
  got record;
  refused boolean;
BEGIN
  FOR got IN SELECT * FROM (VALUES
      (1120.00::numeric, 120.00::numeric, 1120.00::numeric, 'inclusive_12_112_v1'::text, 'nothing withheld'),
      (0.14, 0.01, 0.13, 'inclusive_12_112_v1', 'half a cent rounded down'),
      (1000.00, 120.00, 940.00, 'inclusive_12_112_v1', 'the 12/6 split stamped inclusive'),
      (1120.00, 120.00, 1000.00, 'inclusive_12_112_v2', 'an unknown basis')
    ) AS t(gross, sup, net, basis, why)
  LOOP
    refused := false;
    BEGIN
      INSERT INTO public.trade_invoices (org_id, user_id, status, subtotal_ex, gross_earned, super_rate, super_amount, net_pay, gst_on, gst, total_inc, super_basis, invoice_number)
      VALUES ('00000000-0000-0000-0000-000000000001', 'f1170000-0000-4000-8000-00000000000a', 'pending_acknowledgment',
              got.gross, got.gross, 0.12, got.sup, got.net, false, 0, got.gross, got.basis, 'ZZTEST-BAD');
    EXCEPTION WHEN check_violation THEN refused := true;
    END;
    IF NOT refused THEN RAISE EXCEPTION 'stored: %', got.why; END IF;
  END LOOP;
END $$;
ROLLBACK;

-- 7. An ordinary labour line may sit on an inclusive invoice. On an
--    employer_12_v2 invoice it is still refused.
BEGIN;
INSERT INTO public.users (id, org_id, name) VALUES
  ('f1170000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000001', 'ZZTEST Crew');
INSERT INTO public.jobs (id, org_id, status, type, job_number) VALUES
  ('f1170000-0000-4000-8000-000000000101', '00000000-0000-0000-0000-000000000001', 'scheduled', 'fencing', 'ZZTEST-INC-JOB');
INSERT INTO public.trade_invoices (id, org_id, user_id, status, subtotal_ex, gross_earned, super_rate, super_amount, net_pay, gst_on, gst, total_inc, super_basis, invoice_number)
VALUES ('f1170000-0000-4000-8000-000000000201', '00000000-0000-0000-0000-000000000001', 'f1170000-0000-4000-8000-00000000000a', 'pending_acknowledgment',
        1120.00, 1120.00, 0.12, 120.00, 1000.00, false, 0, 1120.00, 'inclusive_12_112_v1', 'ZZTEST-INC-6'),
       ('f1170000-0000-4000-8000-000000000202', '00000000-0000-0000-0000-000000000001', 'f1170000-0000-4000-8000-00000000000a', 'pending_acknowledgment',
        1000.00, 1000.00, 0.12, 120.00, 1000.00, false, 0, 1000.00, 'employer_12_v2', 'ZZTEST-EMP-1');
INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, job_number, line_type, description, line_total_ex)
VALUES ('f1170000-0000-4000-8000-000000000201', 'f1170000-0000-4000-8000-000000000101', 'ZZTEST-INC-JOB', 'labour', 'ZZTEST labour', 1120.00);
DO $$
DECLARE refused boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, job_number, line_type, description, line_total_ex)
    VALUES ('f1170000-0000-4000-8000-000000000202', 'f1170000-0000-4000-8000-000000000101', 'ZZTEST-INC-JOB', 'labour', 'ZZTEST labour', 1000.00);
  EXCEPTION WHEN check_violation THEN refused := SQLERRM = 'group_super_basis_mismatch';
  END;
  IF NOT refused THEN RAISE EXCEPTION 'a labour line was stored on an employer super invoice'; END IF;
END $$;
ROLLBACK;

-- 8. The rule in SQL: off with the switch off; off with no start date; on
--    from the start date; off the day before.
BEGIN;
DO $$
BEGIN
  IF public.trade_pay_rule_on('2026-12-07') THEN RAISE EXCEPTION 'rule on with the switch off'; END IF;
  UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'trade_pay_inclusive_super_v1';
  IF public.trade_pay_rule_on('2026-12-07') THEN RAISE EXCEPTION 'rule on with no start date'; END IF;
  UPDATE public.trade_pay_settings SET inclusive_super_from = '2026-12-07' WHERE id = 1;
  IF NOT public.trade_pay_rule_on('2026-12-07') THEN RAISE EXCEPTION 'rule off on the start date'; END IF;
  IF public.trade_pay_rule_on('2026-12-06') THEN RAISE EXCEPTION 'rule on the day before the start date'; END IF;
  IF public.trade_pay_rule_on(NULL) THEN RAISE EXCEPTION 'rule on with no pay day'; END IF;
END $$;
-- The start date must be a Monday.
DO $$
DECLARE refused boolean := false;
BEGIN
  BEGIN
    UPDATE public.trade_pay_settings SET inclusive_super_from = '2026-12-08' WHERE id = 1;
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'stored a start date that is not a Monday'; END IF;
END $$;
ROLLBACK;

-- 9. The persists carry the basis and the base onto the row as priced (the
--    persist checks the figures, not which lines are free of super); a
--    payload with none inserts exactly as before.
BEGIN;
INSERT INTO public.users (id, org_id, name) VALUES
  ('f1170000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000001', 'ZZTEST Crew');
INSERT INTO public.jobs (id, org_id, status, type, job_number) VALUES
  ('f1170000-0000-4000-8000-000000000101', '00000000-0000-0000-0000-000000000001', 'scheduled', 'fencing', 'ZZTEST-INC-JOB');
DO $$
DECLARE
  inv uuid;
  got record;
  v_header jsonb;
  v_lines jsonb;
BEGIN
  v_header := jsonb_build_object(
    'org_id', '00000000-0000-0000-0000-000000000001', 'user_id', 'f1170000-0000-4000-8000-00000000000a',
    'week_start', '2026-12-07', 'week_end', '2026-12-13',
    'total_hours', 0, 'total_breaks_minutes', 0,
    'subtotal_ex', 1200, 'gst', 0, 'total_inc', 1200, 'gst_on', false,
    'super_rate', 0.12, 'super_amount', 120, 'gross_earned', 1200, 'net_pay', 1080,
    'super_basis', 'inclusive_12_112_v1', 'super_base_ex', 1120,
    'invoice_source', 'hourly', 'status', 'draft');
  v_lines := jsonb_build_array(
    jsonb_build_object('job_id', 'f1170000-0000-4000-8000-000000000101', 'job_number', 'ZZTEST-INC-JOB', 'line_type', 'labour',
      'description', 'ZZTEST labour', 'quantity', 1, 'unit', 'ea', 'unit_rate', 1120,
      'total_hours', 0, 'line_total_ex', 1120, 'line_position', 0),
    jsonb_build_object('job_id', 'f1170000-0000-4000-8000-000000000101', 'job_number', 'ZZTEST-INC-JOB', 'line_type', 'other',
      'description', 'ZZTEST other line', 'quantity', 1, 'unit', 'ea', 'unit_rate', 80,
      'total_hours', 0, 'line_total_ex', 80, 'line_position', 1));
  inv := public.persist_weekly_trade_invoice_v1(v_header, v_lines, NULL);
  SELECT super_basis, super_base_ex, super_amount, net_pay INTO got FROM public.trade_invoices WHERE id = inv;
  IF got.super_basis IS DISTINCT FROM 'inclusive_12_112_v1' OR got.super_base_ex <> 1120 OR got.super_amount <> 120 OR got.net_pay <> 1080 THEN
    RAISE EXCEPTION 'the weekly persist dropped the super rule: %', got;
  END IF;
  v_header := v_header - 'super_basis' - 'super_base_ex'
    || jsonb_build_object('week_start', '2026-11-30', 'week_end', '2026-12-06',
      'subtotal_ex', 1120, 'total_inc', 1120, 'gross_earned', 1120, 'super_amount', 134.40, 'net_pay', 1052.80);
  inv := public.persist_weekly_trade_invoice_v1(v_header, jsonb_build_array(v_lines->0), NULL);
  SELECT super_basis, super_base_ex INTO got FROM public.trade_invoices WHERE id = inv;
  IF got.super_basis IS NOT NULL OR got.super_base_ex IS NOT NULL THEN
    RAISE EXCEPTION 'a payload with no basis stamped one: %', got;
  END IF;
END $$;
ROLLBACK;

-- 10. Each patch is in its body exactly once, and applying again changes nothing.
BEGIN;
\ir ../../../migrations/20261117020000_trade_pay_inclusive_super.sql
DO $$
DECLARE
  v_def text;
  v_count int;
BEGIN
  v_def := pg_get_functiondef('public.trade_invoice_lines_group_share_snapshot()'::regprocedure);
  IF position('i.super_basis IS NOT NULL' IN v_def) > 0
     OR (length(v_def) - length(replace(v_def, 'i.super_basis = ''employer_12_v2''', ''))) / length('i.super_basis = ''employer_12_v2''') <> 1 THEN
    RAISE EXCEPTION 'the group share line guard is not narrowed exactly once';
  END IF;
  FOREACH v_def IN ARRAY ARRAY[
    pg_get_functiondef('public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)'::regprocedure),
    pg_get_functiondef('public.persist_trade_work_order_invoice_v1(jsonb,jsonb,uuid)'::regprocedure)
  ] LOOP
    v_count := (length(v_def) - length(replace(v_def, 'p_invoice->>''super_basis''', ''))) / length('p_invoice->>''super_basis''');
    IF v_count <> 1 THEN RAISE EXCEPTION 'a persist carries the basis % times', v_count; END IF;
    -- A raised variation must still survive a replaced draft (AGENTS.md).
    IF position('carry_work_order_variations' IN v_def) = 0 THEN
      RAISE EXCEPTION 'a persist lost carry_work_order_variations';
    END IF;
  END LOOP;
  v_def := pg_get_functiondef('public.unfreeze_group_work_order_split(uuid,uuid)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, 'group_split_inclusive_super_invoice', ''))) / length('group_split_inclusive_super_invoice') <> 1 THEN
    RAISE EXCEPTION 'unfreeze does not refuse an inclusive invoice exactly once';
  END IF;
END $$;
ROLLBACK;

