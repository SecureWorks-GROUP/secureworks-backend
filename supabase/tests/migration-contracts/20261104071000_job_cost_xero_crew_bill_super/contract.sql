-- 20261104071000 (A6 rule 2): the company super a crew bill raised in Xero states.
-- Synthetic source documents through the real v_job_cost_events; every expected figure is worked out by hand from the
-- documents, never read back from the view. All fixture writes roll back. Self-run checks (Claude), no production.
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE a6_checks(name text, passed boolean);
CREATE FUNCTION pg_temp.prove(n text, p boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  IF p IS DISTINCT FROM true THEN RAISE EXCEPTION 'A6 cost rules: %', n; END IF;
  INSERT INTO a6_checks VALUES (n, p);
END $$;
CREATE FUNCTION pg_temp.cost_doc(j uuid, d text) RETURNS numeric LANGUAGE sql AS $$
  SELECT coalesce(sum(amount_ex), 0) FROM public.v_job_cost_events WHERE job_id = j AND document_id = d AND is_actual $$;
CREATE FUNCTION pg_temp.ev(r text, b text, l text, amt numeric, alloc text, jn text, j uuid, at timestamptz) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.v_bookkeeping_line_evidence_current (xero_invoice_id, xero_line_item_id, amount_ex_gst, allocation, job_number, job_id, evidenced, basis, revision, stream, emitted_at)
  VALUES (b, l, amt, alloc, jn, j, true, 'supplier_document_job_number', r, regexp_replace(r, '-r[0-9]+$', ''), at) $$;

DO $test$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid(); d uuid := gen_random_uuid();
  n integer; failed boolean;
BEGIN
  INSERT INTO public.organisations (id, name) VALUES (org, 'Synthetic A6 organisation') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.jobs (id, org_id, status, type, job_number, metadata, pricing_json, created_at) VALUES
    (a, org, 'in_progress', 'patio', 'A6-A', '{}', '{}', '2026-09-01'), (b, org, 'in_progress', 'patio', 'A6-B', '{}', '{}', '2026-09-01'),
    (c, org, 'in_progress', 'fencing', 'A6-C', '{}', '{}', '2026-09-01'), (d, org, 'processing', 'makesafe', 'A6-D', '{}', '{}', '2026-09-01');
  INSERT INTO public.feature_flags (flag_name, enabled) VALUES ('job_cost_employer_super_v1', true)
    ON CONFLICT (flag_name) DO UPDATE SET enabled = true;
  INSERT INTO public.bookkeeping_evidence_revisions (revision, stream, revision_no, schema, producer, emitted_at, sha256, facts_in_file, facts_sent, rows_loaded, status)
  VALUES ('a6t-ledger-cost-r1', 'a6t-ledger-cost', 1, 'bookkeeping-financial-evidence/1.0', 'synthetic', '2026-11-01T00:00:00Z', 'sha-r1', 0, 0, 0, 'current'),
         ('a6t-ledger-cost-r0', 'a6t-ledger-cost', 0, 'bookkeeping-financial-evidence/1.0', 'synthetic', '2026-10-01T00:00:00Z', 'sha-r0', 0, 0, 0, 'superseded');

  -- A crew bill raised straight in Xero: 195 on A, 225 on B (ledger), super line -25.20 stating a company
  -- contribution of 25.20 on a submitted total of 420. A carries 195 + 195 / 420 x 25.20 = 206.70; B 225 + 13.50.
  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, fully_paid_on, job_id, raw_json, line_items) VALUES
    (org, 'b-crew', NULL, 'ACCPAY', 'PAID', 'Crew Person', 394.80, 394.80, '2026-10-24', '2026-10-24', NULL, '{"LineAmountTypes": "Exclusive"}',
     '[{"LineItemID": "l-c1", "Description": "Crew Person\nA6-A | SW - PATIOS\nLabour 6.5h", "AccountCode": "306", "LineAmount": 195, "TaxAmount": 0},
       {"LineItemID": "l-c2", "Description": "Crew Person\nA6-B | SW - PATIOS\nLabour 7.5h", "AccountCode": "306", "LineAmount": 225, "TaxAmount": 0},
       {"LineItemID": "l-c3", "Description": "Superannuation Guarantee 12.00% of submitted total\nSubmitted total $420.00. Super remittance $50.40. Worker withhold $25.20. Company contribution $25.20. Amount payable $394.80.", "AccountCode": "306", "LineAmount": -25.20, "TaxAmount": 0}]');
  PERFORM pg_temp.ev('a6t-ledger-cost-r1', 'b-crew', 'l-c1', 195, 'job', 'A6-A', a, '2026-11-01');
  PERFORM pg_temp.ev('a6t-ledger-cost-r1', 'b-crew', 'l-c2', 225, 'job', 'A6-B', b, '2026-11-01');
  PERFORM public.bookkeeping_evidence_add_parts('a6t-ledger-cost-r1', 'sha-r1', jsonb_build_array(
    jsonb_build_object('b', 'b-crew', 'l', 'l-c3', 'p', 1, 'n', 2, 's', -25.20, 'a', -11.70, 'j', 'A6-A', 'k', 'job', 'e', 'true', 'w', true),
    jsonb_build_object('b', 'b-crew', 'l', 'l-c3', 'p', 2, 'n', 2, 's', -25.20, 'a', -13.50, 'j', 'A6-B', 'k', 'job', 'e', 'true', 'w', true)));
  PERFORM pg_temp.prove('crew bill: A carries its line and its share of the stated company super', pg_temp.cost_doc(a, 'b-crew') = 206.70);
  PERFORM pg_temp.prove('crew bill: B carries its line and its share of the stated company super', pg_temp.cost_doc(b, 'b-crew') = 238.50);
  PERFORM pg_temp.prove('crew bill: the company super is unpaid labour, source bill_employer_super, one per line',
    (SELECT count(*) FROM public.v_job_cost_events WHERE document_id = 'b-crew' AND source = 'bill_employer_super' AND lane = 'labour' AND lane_detail = 'employer_super' AND NOT paid) = 2
    AND (SELECT amount_ex FROM public.v_job_cost_events WHERE source_id = 'b-crew:1:employer_super') = 11.70);
  PERFORM pg_temp.prove('crew bill: the super withheld from pay is never a cost (not even its ledger parts)',
    NOT EXISTS (SELECT 1 FROM public.v_job_cost_events WHERE document_id = 'b-crew' AND amount_ex < 0));
  UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'job_cost_employer_super_v1';
  PERFORM pg_temp.prove('crew bill: with employer super off only the lines count', pg_temp.cost_doc(a, 'b-crew') = 195 AND pg_temp.cost_doc(b, 'b-crew') = 225);
  UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_cost_employer_super_v1';

  -- A super line that states no contribution adds nothing; its withholding is still not a cost.
  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, job_id, raw_json, line_items) VALUES
    (org, 'b-crew3', NULL, 'ACCPAY', 'PAID', 'Crew Person', 94, 94, '2026-10-25', NULL, '{"LineAmountTypes": "Exclusive"}',
     '[{"LineItemID": "l-d1", "Description": "Labour A6-A", "AccountCode": "306", "LineAmount": 100, "TaxAmount": 0},
       {"LineItemID": "l-d2", "Description": "Superannuation withheld", "AccountCode": "306", "LineAmount": -6, "TaxAmount": 0}]');
  PERFORM pg_temp.ev('a6t-ledger-cost-r1', 'b-crew3', 'l-d1', 100, 'job', 'A6-A', a, '2026-11-01');
  PERFORM pg_temp.prove('a super line with no stated contribution adds nothing', pg_temp.cost_doc(a, 'b-crew3') = 100
    AND NOT EXISTS (SELECT 1 FROM public.v_job_cost_events WHERE document_id = 'b-crew3' AND source = 'bill_employer_super'));

  -- On a bill the office placed whole, the super row follows its line (here an installer bill still to confirm).
  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, job_id, raw_json, line_items) VALUES
    (org, 'b-crew2', NULL, 'ACCPAY', 'AUTHORISED', 'Installer Two', 94, 94, '2026-10-25', c, '{"LineAmountTypes": "Exclusive"}',
     '[{"LineItemID": "l-e1", "Description": "Install day", "AccountCode": "306", "LineAmount": 100, "TaxAmount": 0},
       {"LineItemID": "l-e2", "Description": "Superannuation Guarantee withheld. Company contribution $6.00.", "AccountCode": "306", "LineAmount": -6, "TaxAmount": 0}]');
  PERFORM pg_temp.prove('office-placed crew bill: the super row follows its unconfirmed line and the withholding is not a cost',
    (SELECT count(*) FROM public.v_job_cost_events WHERE document_id = 'b-crew2' AND source = 'installer_bill_unconfirmed' AND NOT is_actual) = 2
    AND (SELECT sum(amount_ex) FROM public.v_job_cost_events WHERE document_id = 'b-crew2') = 106);

  -- A crew-app mirror bill stays out: its super is the crew invoice's.
  INSERT INTO public.users (id, org_id, name) VALUES ('a6000000-0000-4000-8000-000000000001', org, 'Synthetic A6 crew');
  INSERT INTO public.trade_invoices (id, org_id, user_id, week_start, status, subtotal_ex, gst, total_inc, invoice_number, xero_bill_id)
  VALUES (gen_random_uuid(), org, 'a6000000-0000-4000-8000-000000000001', '2026-10-19', 'approved', 100, 0, 100, 'SW-INV-T-1', 'b-mirror');
  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, job_id, raw_json, line_items) VALUES
    (org, 'b-mirror', 'SW-INV-T-1', 'ACCPAY', 'PAID', 'Crew Person', 94, 94, '2026-10-26', NULL, '{"LineAmountTypes": "Exclusive"}',
     '[{"LineItemID": "l-m1", "Description": "Crew Person\nA6-A | SW - PATIOS", "AccountCode": "306", "LineAmount": 100, "TaxAmount": 0},
       {"LineItemID": "l-m2", "Description": "Superannuation Guarantee. Company contribution $6.00.", "AccountCode": "306", "LineAmount": -6, "TaxAmount": 0}]');
  PERFORM pg_temp.ev('a6t-ledger-cost-r1', 'b-mirror', 'l-m1', 100, 'job', 'A6-A', a, '2026-11-01');
  PERFORM pg_temp.prove('a crew-app mirror bill adds nothing, super included', NOT EXISTS (SELECT 1 FROM public.v_job_cost_events WHERE document_id = 'b-mirror'));
END $test$;
SELECT jsonb_build_object('checks', count(*), 'passed', count(*) FILTER (WHERE passed)) AS result FROM a6_checks;
ROLLBACK;
