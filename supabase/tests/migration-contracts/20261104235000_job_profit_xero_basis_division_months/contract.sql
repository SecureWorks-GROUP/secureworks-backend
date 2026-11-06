-- 20261104235000 (A3): division-month totals on Xero's accounting basis, from Job Profit's own rows.
-- Synthetic source documents through the real v_job_cost_events and v_job_revenue_events; every expected date, division
-- and amount is worked out by hand from the fixture documents, never read back from the view. All fixture writes roll
-- back. Self-run checks (Claude), no production.
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE xb_checks(name text, passed boolean);
CREATE FUNCTION pg_temp.prove(n text, p boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  IF p IS DISTINCT FROM true THEN RAISE EXCEPTION 'A3 Xero basis: %', n; END IF;
  INSERT INTO xb_checks VALUES (n, p);
END $$;
CREATE FUNCTION pg_temp.ev(r text, b text, l text, amt numeric, alloc text, jn text, j uuid, at timestamptz) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.v_bookkeeping_line_evidence_current (xero_invoice_id, xero_line_item_id, amount_ex_gst, allocation, job_number, job_id, evidenced, basis, revision, stream, emitted_at)
  VALUES (b, l, amt, alloc, jn, j, true, 'synthetic', r, regexp_replace(r, '-r[0-9]+$', ''), at) $$;

-- The job-division rule (A3 item 8): the ops-api rule, with SWB- and, by the job's type, SWG-, SWM- and old SW1xxx.
SELECT pg_temp.prove('division: SWB- is SW - BUILDS whatever the type', public.job_profit_job_division('SWB-26073', 'patio') = 'SW - BUILDS');
SELECT pg_temp.prove('division: SWG- takes its type', public.job_profit_job_division('SWG-20260713-BE', 'fencing') = 'SW - FENCING');
SELECT pg_temp.prove('division: SWM- takes its type; a miscellaneous type names none',
  public.job_profit_job_division('SWM-261607', 'miscellaneous') IS NULL AND public.job_profit_job_division('SWM-261607', 'patio') = 'SW - PATIOS');
SELECT pg_temp.prove('division: an old SW1xxx number takes its type', public.job_profit_job_division('SW1346', 'patio') = 'SW - PATIOS'
  AND public.job_profit_job_division('SW1797', 'fencing') = 'SW - FENCING');
SELECT pg_temp.prove('division: SWMS- stays Make Safe (never read as SWM-)', public.job_profit_job_division('SWMS-261233', 'makesafe') = 'SW - MAKESAFE');
SELECT pg_temp.prove('division: unchanged prefixes and types', public.job_profit_job_division('SWP-26100', NULL) = 'SW - PATIOS'
  AND public.job_profit_job_division('SWF-26100', NULL) = 'SW - FENCING' AND public.job_profit_job_division('SWR-261400', 'repair') = 'SW - MAKESAFE'
  AND public.job_profit_job_division('SWR-261400', NULL) IS NULL AND public.job_profit_job_division('', 'patio') IS NULL
  AND public.job_profit_job_division('AJBR-1', NULL) = 'SW - MAKESAFE');

DO $test$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  p uuid := gen_random_uuid(); f uuid := gen_random_uuid();
  crew uuid := 'a3b00000-0000-4000-8000-000000000001';
  t1 uuid := gen_random_uuid(); t2 uuid := gen_random_uuid();
  l1 uuid := gen_random_uuid(); l2 uuid := gen_random_uuid(); l3 uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.organisations (id, name) VALUES (org, 'Synthetic A3 organisation') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.jobs (id, org_id, status, type, job_number, metadata, pricing_json, created_at) VALUES
    (p, org, 'in_progress', 'patio', 'SWP-90001', '{}', '{}', '2026-07-01'),
    (f, org, 'in_progress', 'fencing', 'SWF-90002', '{}', '{}', '2026-07-01');
  INSERT INTO public.feature_flags (flag_name, enabled) VALUES ('job_cost_employer_super_v1', true)
    ON CONFLICT (flag_name) DO UPDATE SET enabled = true;
  INSERT INTO public.users (id, org_id, name) VALUES (crew, org, 'Synthetic A3 crew');
  INSERT INTO public.bookkeeping_evidence_revisions (revision, stream, revision_no, schema, producer, emitted_at, sha256, facts_in_file, facts_sent, rows_loaded, status)
  VALUES ('a3xb-ledger-cost-r1', 'a3xb-ledger-cost', 1, 'bookkeeping-financial-evidence/1.0', 'synthetic', '2026-11-01T00:00:00Z', 'sha-a3xb', 0, 0, 0, 'current');

  -- Crew: a week of work (28 and 31 August) on its crew invoice, posted to Xero as a bill dated 3 September; Bookkeeping
  -- tracked the first line to SW - INSURANCE WORK and the second to SW - PATIOS. A second crew invoice has no bill.
  INSERT INTO public.trade_invoices (id, org_id, user_id, week_start, status, subtotal_ex, gst, total_inc, invoice_number, xero_bill_id,
                                     gst_on, super_rate, gross_earned, super_amount, net_pay, super_basis) VALUES
    (t1, org, crew, '2026-08-24', 'approved', 300, 0, 300, 'SW-INV-XB-1', 'b-xbcrew', false, 0.12, 300, 36, 282, NULL),
    (t2, org, crew, '2026-08-24', 'approved', 90, 0, 90, 'SW-INV-XB-2', NULL, false, 0.12, 90, 10.80, 84.60, NULL);
  INSERT INTO public.trade_invoice_lines (id, trade_invoice_id, job_id, job_number, line_type, description, total_hours, hourly_rate, line_total_ex, line_date, created_at) VALUES
    (l1, t1, p, 'SWP-90001', 'labour', 'Labour', 5, 40, 200, '2026-08-28', '2026-09-01 01:00:00+00'),
    (l2, t1, p, 'SWP-90001', 'labour', 'Labour', 2.5, 40, 100, '2026-08-31', '2026-09-01 01:00:01+00'),
    (l3, t2, f, 'SWF-90002', 'labour', 'Labour', 2.25, 40, 90, '2026-08-30', '2026-09-01 01:00:02+00');
  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, job_id, raw_json, line_items) VALUES
    (org, 'b-xbcrew', 'SW-INV-XB-1', 'ACCPAY', 'AUTHORISED', 'Synthetic A3 crew', 300, 300, '2026-09-03', NULL, '{"LineAmountTypes": "NoTax"}',
     '[{"LineItemID": "c1", "Description": "SWP-90001 | SW - PATIOS\nLabour 5h", "AccountCode": "306", "LineAmount": 200, "Tracking": [{"Name": "Business Unit", "Option": "SW - INSURANCE WORK"}]},
       {"LineItemID": "c2", "Description": "SWP-90001 | SW - PATIOS\nLabour 2.5h", "AccountCode": "306", "LineAmount": 100, "Tracking": [{"Name": "Business Unit", "Option": "SW - PATIOS"}]}]');

  -- A supplier bill on the fence job (12 August, tracked SW - FENCING, 200 ex), credited in Xero by two credit notes:
  -- CN-XA (10 October, tracked SW - INSURANCE WORK) applies 44.00 and CN-XB (2 November, tracked SW - FENCING) 22.00,
  -- 66.00 of the bill's 220.00, so Job Profit nets 60.00: 40.00 on CN-XA's date and tracking, 20.00 on CN-XB's.
  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, job_id, raw_json, line_items) VALUES
    (org, 'b-xbsup', 'XB-SUP-1', 'ACCPAY', 'PAID', 'Synthetic supplier', 200, 220, '2026-08-12', f,
     '{"LineAmountTypes": "Exclusive", "AmountCredited": 66, "CreditNotes": [{"CreditNoteID": "cn-xa", "AppliedAmount": 44}, {"CreditNoteID": "cn-xb", "AppliedAmount": 22}]}',
     '[{"LineItemID": "s1", "Description": "Fence palings", "AccountCode": "305", "LineAmount": 200, "TaxAmount": 20, "Tracking": [{"Name": "Business Unit", "Option": "SW - FENCING"}]}]');
  INSERT INTO public.xero_supplier_credit_notes (org_id, xero_credit_note_id, credit_note_type, credit_note_number, contact_name, credit_note_date, status, line_amount_types, currency_code, sub_total, total_tax, total, remaining_credit, allocations_returned, xero_updated_at, raw_json) VALUES
    (org, 'cn-xa', 'ACCPAYCREDIT', 'CN-XA', 'Synthetic supplier', '2026-10-10', 'PAID', 'Exclusive', 'AUD', 40, 4, 44, 0, true, '2026-10-10',
     '{"LineItems": [{"LineItemID": "cna1", "AccountCode": "305", "LineAmount": 40, "TaxAmount": 4, "Tracking": [{"Name": "Business Unit", "Option": "SW - INSURANCE WORK"}]}]}'),
    (org, 'cn-xb', 'ACCPAYCREDIT', 'CN-XB', 'Synthetic supplier', '2026-11-02', 'PAID', 'Exclusive', 'AUD', 20, 2, 22, 0, true, '2026-11-02',
     '{"LineItems": [{"LineItemID": "cnb1", "AccountCode": "305", "LineAmount": 20, "TaxAmount": 2, "Tracking": [{"Name": "Business Unit", "Option": "SW - FENCING"}]}]}');
  INSERT INTO public.xero_supplier_credit_note_allocations (org_id, xero_credit_note_id, n, allocation_id, xero_invoice_id, invoice_number, amount, allocation_date, is_deleted, raw_json) VALUES
    (org, 'cn-xa', 1, 'al-xa', 'b-xbsup', 'XB-SUP-1', 44, '2026-10-10', false, '{}'),
    (org, 'cn-xb', 1, 'al-xb', 'b-xbsup', 'XB-SUP-1', 22, '2026-11-02', false, '{}');

  -- A customer invoice (3 August, tracked SW - PATIOS, 1,000 ex) with one credit note CN-XC applied (110 of 1,100, dated
  -- 17 September in Xero): Job Profit nets 100.00 from revenue; on Xero's basis it counts on 17 September.
  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, job_id, raw_json, line_items) VALUES
    (org, 'i-xbcus', 'XB-INV-1', 'ACCREC', 'PAID', 'Synthetic customer', 1000, 1100, '2026-08-03', p,
     '{"LineAmountTypes": "Exclusive", "CreditNotes": [{"CreditNoteID": "cn-xc", "CreditNoteNumber": "CN-XC", "AppliedAmount": 110, "DateString": "2026-09-17T00:00:00"}]}',
     '[{"LineItemID": "r1", "Description": "Patio", "AccountCode": "208", "LineAmount": 1000, "TaxAmount": 100, "Tracking": [{"Name": "Business Unit", "Option": "SW - PATIOS"}]}]');

  -- Bookkeeping's overhead: a bill on no job (5 September) with a Cost of Sales line (305, 50.00, SW - GROUP) and an
  -- operating-expense line (429, 20.00), both evidenced to overhead: only the 305 line is a row, on no job.
  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, job_id, raw_json, line_items) VALUES
    (org, 'b-xboh', 'XB-OH-1', 'ACCPAY', 'PAID', 'Synthetic store', 70, 77, '2026-09-05', NULL, '{"LineAmountTypes": "Exclusive"}',
     '[{"LineItemID": "o1", "Description": "Yard stock", "AccountCode": "305", "LineAmount": 50, "TaxAmount": 5, "Tracking": [{"Name": "Business Unit", "Option": "SW - GROUP"}]},
       {"LineItemID": "o2", "Description": "Stationery", "AccountCode": "429", "LineAmount": 20, "TaxAmount": 2}]');
  PERFORM pg_temp.ev('a3xb-ledger-cost-r1', 'b-xboh', 'o1', 50, 'overhead', NULL, NULL, '2026-11-01');
  PERFORM pg_temp.ev('a3xb-ledger-cost-r1', 'b-xboh', 'o2', 20, 'overhead', NULL, NULL, '2026-11-01');
END $test$;

CREATE TEMP TABLE xb AS SELECT * FROM public.v_job_profit_xero_basis_lines
 WHERE job_number IN ('SWP-90001', 'SWF-90002') OR document_id IN ('b-xboh');

SELECT pg_temp.prove('crew: each line on its posted bill''s date, divided by that bill line''s tracking',
  (SELECT count(*) FROM xb WHERE kind = 'trade_line' AND job_number = 'SWP-90001' AND posted_on = '2026-09-03' AND date_basis = 'crew_bill_date' AND in_figure) = 2
  AND (SELECT amount_ex FROM xb WHERE kind = 'trade_line' AND division = 'SW - INSURANCE WORK' AND xero_document_id = 'b-xbcrew') = 200
  AND (SELECT amount_ex FROM xb WHERE kind = 'trade_line' AND division = 'SW - PATIOS' AND xero_document_id = 'b-xbcrew') = 100
  AND (SELECT job_profit_date FROM xb WHERE kind = 'trade_line' AND amount_ex = 200 AND job_number = 'SWP-90001') = '2026-08-28');
SELECT pg_temp.prove('crew: a crew invoice with no posted bill keeps its work date and the job''s division',
  (SELECT posted_on = '2026-08-30' AND division = 'SW - FENCING' AND date_basis = 'work_date_no_posted_bill' AND division_basis = 'job'
     FROM xb WHERE kind = 'trade_line' AND job_number = 'SWF-90002'));
SELECT pg_temp.prove('employer super stays in the view but out of the figure',
  (SELECT count(*) FROM xb WHERE kind IN ('trade_employer_super', 'bill_employer_super')) > 0
  AND NOT EXISTS (SELECT 1 FROM xb WHERE kind IN ('trade_employer_super', 'bill_employer_super') AND (in_figure OR not_in_figure_reason IS DISTINCT FROM 'employer_super_not_cost_of_sales')));
SELECT pg_temp.prove('supplier bill line: its own date and tracking',
  (SELECT posted_on = '2026-08-12' AND division = 'SW - FENCING' AND amount_ex = 200 FROM xb WHERE kind = 'supplier_bill' AND job_number = 'SWF-90002'));
SELECT pg_temp.prove('supplier credit: the bill''s credit share on each credit note''s date and tracking, by the amount each applies',
  (SELECT sum(amount_ex) FROM xb WHERE kind = 'supplier_credit' AND job_number = 'SWF-90002') = -60
  AND (SELECT sum(amount_ex) FROM xb WHERE kind = 'supplier_credit' AND posted_on = '2026-10-10' AND division = 'SW - INSURANCE WORK' AND xero_document_id = 'cn-xa') = -40
  AND (SELECT sum(amount_ex) FROM xb WHERE kind = 'supplier_credit' AND posted_on = '2026-11-02' AND division = 'SW - FENCING' AND xero_document_id = 'cn-xb') = -20);
SELECT pg_temp.prove('customer credit: on its one credit note''s date',
  (SELECT posted_on = '2026-09-17' AND amount_ex = -100 AND division = 'SW - PATIOS' AND xero_document_id = 'cn-xc' AND date_basis = 'credit_note_date'
     FROM xb WHERE kind = 'credit_applied' AND job_number = 'SWP-90001'));
SELECT pg_temp.prove('customer invoice line: its own date and tracking',
  (SELECT posted_on = '2026-08-03' AND division = 'SW - PATIOS' AND amount_ex = 1000 FROM xb WHERE kind = 'invoice_line' AND job_number = 'SWP-90001'));
SELECT pg_temp.prove('Bookkeeping overhead: a Cost of Sales line is a row of its own, on no job, with its own date and tracking; an operating expense line is not',
  (SELECT count(*) FROM xb WHERE document_id = 'b-xboh') = 1
  AND (SELECT job_id IS NULL AND kind = 'overhead' AND amount_ex = 50 AND division = 'SW - GROUP' AND posted_on = '2026-09-05' AND in_figure
         FROM xb WHERE document_id = 'b-xboh'));
SELECT pg_temp.prove('every job''s rows add up to v_job_profit to the cent (revenue and cost, in the figure or not)',
  NOT EXISTS (
    SELECT 1 FROM public.v_job_profit v
      LEFT JOIN (SELECT job_id, sum(amount_ex) FILTER (WHERE side = 'revenue') rev, sum(amount_ex) FILTER (WHERE side = 'cost') cost
                   FROM public.v_job_profit_xero_basis_lines WHERE job_id IS NOT NULL GROUP BY job_id) x ON x.job_id = v.job_id
     WHERE round(COALESCE(v.invoiced_ex, 0), 2) <> round(COALESCE(x.rev, 0), 2) OR round(COALESCE(v.actual_cost_ex, 0), 2) <> round(COALESCE(x.cost, 0), 2)));
SELECT pg_temp.prove('the division-month figure sums the rows in the figure, by Xero date and division',
  (SELECT amount_ex FROM public.v_job_profit_division_months WHERE division = 'SW - INSURANCE WORK' AND month = '2026-09-01' AND side = 'cost')
    = (SELECT sum(amount_ex) FROM public.v_job_profit_xero_basis_lines WHERE in_figure AND division = 'SW - INSURANCE WORK' AND side = 'cost'
         AND posted_on >= '2026-09-01' AND posted_on < '2026-10-01')
  AND (SELECT amount_ex FROM public.v_job_profit_division_months WHERE division = 'SW - GROUP' AND month = '2026-09-01' AND side = 'cost') >= 50
  AND (SELECT sum(lines) FROM public.v_job_profit_division_months) = (SELECT count(*) FROM public.v_job_profit_xero_basis_lines WHERE in_figure));
SELECT pg_temp.prove('read only, service role only',
  has_table_privilege('service_role', 'public.v_job_profit_division_months', 'SELECT')
  AND has_table_privilege('service_role', 'public.v_job_profit_xero_basis_lines', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.v_job_profit_division_months', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.v_job_profit_xero_basis_lines', 'SELECT')
  AND has_function_privilege('service_role', 'public.job_profit_job_division(text, text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.job_profit_job_division(text, text)', 'EXECUTE'));
SELECT jsonb_build_object('checks', count(*), 'passed', count(*) FILTER (WHERE passed)) AS result FROM xb_checks;
ROLLBACK;
