-- 20261104090000 (A3): a crew line and a materials placement carry the division of the Xero bill line they are paid on.
-- Synthetic source documents through the real v_job_cost_events; every expected division is read from the fixture
-- documents by hand, never from the view. All fixture writes roll back. Self-run checks (Claude), no production.
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE a3_checks(name text, passed boolean);
CREATE FUNCTION pg_temp.prove(n text, p boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  IF p IS DISTINCT FROM true THEN RAISE EXCEPTION 'A3 division rule: %', n; END IF;
  INSERT INTO a3_checks VALUES (n, p);
END $$;
CREATE FUNCTION pg_temp.bu(sid text) RETURNS text LANGUAGE sql AS $$
  SELECT business_unit FROM public.v_job_cost_events WHERE source_id = sid $$;

DO $test$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  p uuid := gen_random_uuid(); bj uuid := gen_random_uuid(); f uuid := gen_random_uuid();
  crew uuid := 'a3000000-0000-4000-8000-000000000001';
  ti uuid := gen_random_uuid();
  l1 uuid := gen_random_uuid(); l2 uuid := gen_random_uuid(); l3 uuid := gen_random_uuid(); l4 uuid := gen_random_uuid();
  m1 uuid := gen_random_uuid(); m2 uuid := gen_random_uuid(); m3 uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.organisations (id, name) VALUES (org, 'Synthetic A3 organisation') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.jobs (id, org_id, status, type, job_number, metadata, pricing_json, created_at) VALUES
    (p, org, 'in_progress', 'patio', 'A3T-P1', '{}', '{}', '2026-09-01'),
    (bj, org, 'in_progress', 'patio', 'A3T-B1', '{}', '{}', '2026-09-01'),
    (f, org, 'in_progress', 'fencing', 'A3T-F1', '{}', '{}', '2026-09-01');
  INSERT INTO public.feature_flags (flag_name, enabled) VALUES ('job_cost_employer_super_v1', true)
    ON CONFLICT (flag_name) DO UPDATE SET enabled = true;
  INSERT INTO public.users (id, org_id, name) VALUES (crew, org, 'Synthetic A3 crew');

  -- A crew invoice of four lines (A3T-P1 200, A3T-B1 80, A3T-F1 80, A3T-P1 55) and its own Xero bill. Bookkeeping
  -- tracked the bill's lines: line 1 (A3T-P1 200) to SW - INSURANCE WORK; line 2 (old duplicate warning, no job
  -- number, 80) to SW - BUILDS; line 3 (A3T-F1, 80) to SW - FENCING; then a super line. No bill line is 55.
  INSERT INTO public.trade_invoices (id, org_id, user_id, week_start, status, subtotal_ex, gst, total_inc, invoice_number, xero_bill_id,
                                     gst_on, super_rate, gross_earned, super_amount, net_pay)
  VALUES (ti, org, crew, '2026-08-24', 'approved', 415, 0, 415, 'SW-INV-A3T-1', 'b-a3crew', false, 0.12, 415, 49.80, 415);
  INSERT INTO public.trade_invoice_lines (id, trade_invoice_id, job_id, job_number, line_type, description, total_hours, hourly_rate, line_total_ex, line_date, created_at) VALUES
    (l1, ti, p, 'A3T-P1', 'labour', 'Labour', 5, 40, 200, '2026-08-25', '2026-08-30 01:00:00+00'),
    (l2, ti, bj, 'A3T-B1', 'labour', 'Labour', 2, 40, 80, '2026-08-26', '2026-08-30 01:00:01+00'),
    (l3, ti, f, 'A3T-F1', 'labour', 'Labour', 2, 40, 80, '2026-08-27', '2026-08-30 01:00:02+00'),
    (l4, ti, p, 'A3T-P1', 'labour', 'Labour', 1.375, 40, 55, '2026-08-28', '2026-08-30 01:00:03+00');
  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, job_id, raw_json, line_items) VALUES
    (org, 'b-a3crew', 'SW-INV-A3T-1', 'ACCPAY', 'AUTHORISED', 'Synthetic A3 crew', 330, 330, '2026-08-31', NULL, '{"LineAmountTypes": "NoTax"}',
     '[{"LineItemID": "c1", "Description": "Synthetic A3 crew\nA3T-P1 | SW - PATIOS\nLabour 5h", "AccountCode": "306", "LineAmount": 200, "Tracking": [{"Name": "Business Unit", "Option": "SW - INSURANCE WORK"}]},
       {"LineItemID": "c2", "Description": "POSSIBLE DUPLICATE - verify prior trade invoice before approving", "AccountCode": "306", "LineAmount": 80, "Tracking": [{"Name": "Business Unit", "Option": "SW - BUILDS"}]},
       {"LineItemID": "c3", "Description": "A3T-F1 | SW - FENCING\nLabour 2h", "AccountCode": "306", "LineAmount": 80, "Tracking": [{"Name": "Business Unit", "Option": "SW - FENCING"}]},
       {"LineItemID": "c4", "Description": "Superannuation Guarantee 12.00% of submitted total", "AccountCode": "306", "LineAmount": -30, "Tracking": [{"Name": "Business Unit", "Option": "SW - GROUP"}]}]');

  PERFORM pg_temp.prove('crew line: same amount and job number takes that bill line''s division', pg_temp.bu(l1::text) = 'SW - INSURANCE WORK');
  PERFORM pg_temp.prove('crew line: the job-numbered line pairs before the amount-only line', pg_temp.bu(l3::text) = 'SW - FENCING');
  PERFORM pg_temp.prove('crew line: a line whose bill text lost its job number pairs on amount', pg_temp.bu(l2::text) = 'SW - BUILDS');
  PERFORM pg_temp.prove('crew line: no bill line of the same amount keeps no division (its job decides, as before)', pg_temp.bu(l4::text) IS NULL);
  PERFORM pg_temp.prove('crew line: the super withheld line never pairs', NOT EXISTS (SELECT 1 FROM public.v_job_cost_events WHERE document_id = ti::text AND business_unit = 'SW - GROUP'));
  PERFORM pg_temp.prove('crew lines: no row added or repeated, amounts as the crew invoice states',
    (SELECT count(*) FROM public.v_job_cost_events WHERE document_id = ti::text AND source = 'trade_line') = 4
    AND (SELECT sum(amount_ex) FROM public.v_job_cost_events WHERE document_id = ti::text AND source = 'trade_line') = 415);
  PERFORM pg_temp.prove('crew line: its employer super follows the line''s division',
    (SELECT business_unit FROM public.v_job_cost_events WHERE source_id = l1::text || ':employer_super') = 'SW - INSURANCE WORK'
    AND (SELECT business_unit FROM public.v_job_cost_events WHERE source_id = l4::text || ':employer_super') IS NULL);
  -- The bill is not posted (draft): no division is taken from it.
  UPDATE public.xero_invoices SET status = 'DRAFT' WHERE xero_invoice_id = 'b-a3crew';
  PERFORM pg_temp.prove('crew line: a bill not posted in Xero gives no division', pg_temp.bu(l1::text) IS NULL AND pg_temp.bu(l2::text) IS NULL);
  UPDATE public.xero_invoices SET status = 'AUTHORISED' WHERE xero_invoice_id = 'b-a3crew';

  -- Placements: a bill whose every line with an amount is tracked to one division; one with two divisions; one with an
  -- untracked line that has an amount. A zero line with no tracking does not count.
  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, job_id, raw_json, line_items) VALUES
    (org, 'b-a3m1', 'A3M-1', 'ACCPAY', 'PAID', 'Synthetic supplier', 150, 165, '2026-08-12', NULL, '{"LineAmountTypes": "Exclusive"}',
     '[{"LineItemID": "m1a", "Description": "Fencing material", "AccountCode": "305", "LineAmount": 100, "TaxAmount": 10, "Tracking": [{"Name": "Business Unit", "Option": "SW - INSURANCE WORK"}]},
       {"LineItemID": "m1b", "Description": "Delivery", "AccountCode": "305", "LineAmount": 50, "TaxAmount": 5, "Tracking": [{"Name": "Business Unit", "Option": "SW - INSURANCE WORK"}]},
       {"LineItemID": "m1c", "Description": "Note", "LineAmount": 0}]'),
    (org, 'b-a3m2', 'A3M-2', 'ACCPAY', 'PAID', 'Synthetic supplier', 150, 165, '2026-08-12', NULL, '{"LineAmountTypes": "Exclusive"}',
     '[{"LineItemID": "m2a", "Description": "Posts", "AccountCode": "305", "LineAmount": 100, "TaxAmount": 10, "Tracking": [{"Name": "Business Unit", "Option": "SW - PATIOS"}]},
       {"LineItemID": "m2b", "Description": "Rails", "AccountCode": "305", "LineAmount": 50, "TaxAmount": 5, "Tracking": [{"Name": "Business Unit", "Option": "SW - FENCING"}]}]'),
    (org, 'b-a3m3', 'A3M-3', 'ACCPAY', 'PAID', 'Synthetic supplier', 150, 165, '2026-08-12', NULL, '{"LineAmountTypes": "Exclusive"}',
     '[{"LineItemID": "m3a", "Description": "Posts", "AccountCode": "305", "LineAmount": 100, "TaxAmount": 10, "Tracking": [{"Name": "Business Unit", "Option": "SW - PATIOS"}]},
       {"LineItemID": "m3b", "Description": "Rails", "AccountCode": "305", "LineAmount": 50, "TaxAmount": 5}]');
  INSERT INTO public.job_materials_facts (id, org_id, xero_invoice_id, invoice_number, contact_name, job_id, job_number, lane, kind, amount_ex_gst, amount_inc_gst, confidence, automation_source, fact_date) VALUES
    (m1, org, 'b-a3m1', 'A3M-1', 'Synthetic supplier', p, 'A3T-P1', 'materials', 'actual', 150, 165, 'high', 'agent_ai', '2026-08-12'),
    (m2, org, 'b-a3m2', 'A3M-2', 'Synthetic supplier', p, 'A3T-P1', 'materials', 'actual', 150, 165, 'high', 'agent_ai', '2026-08-12'),
    (m3, org, 'b-a3m3', 'A3M-3', 'Synthetic supplier', p, 'A3T-P1', 'materials', 'actual', 150, 165, 'high', 'agent_ai', '2026-08-12');
  PERFORM pg_temp.prove('placement: a bill with one division gives it to the placement', pg_temp.bu(m1::text) = 'SW - INSURANCE WORK');
  PERFORM pg_temp.prove('placement: a bill with two divisions gives none', pg_temp.bu(m2::text) IS NULL);
  PERFORM pg_temp.prove('placement: a bill with an untracked line of value gives none', pg_temp.bu(m3::text) IS NULL);
  PERFORM pg_temp.prove('placement: amounts unchanged, one row each',
    (SELECT count(*) FROM public.v_job_cost_events WHERE source = 'materials_fact' AND source_id IN (m1::text, m2::text, m3::text)) = 3
    AND (SELECT sum(amount_ex) FROM public.v_job_cost_events WHERE source = 'materials_fact' AND source_id IN (m1::text, m2::text, m3::text)) = 450);
  PERFORM pg_temp.prove('job totals unchanged: the patio job carries 200 + 55 crew, their super, and 450 placed',
    (SELECT actual_cost_ex FROM public.v_job_profit WHERE job_id = p)
      = (SELECT sum(amount_ex) FROM public.v_job_cost_events WHERE job_id = p AND is_actual AND lane IN ('labour', 'materials', 'commission', 'other')));
END $test$;
SELECT jsonb_build_object('checks', count(*), 'passed', count(*) FILTER (WHERE passed)) AS result FROM a3_checks;
ROLLBACK;
