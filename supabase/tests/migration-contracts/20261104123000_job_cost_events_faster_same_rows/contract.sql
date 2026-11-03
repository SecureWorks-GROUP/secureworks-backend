-- 20261104123000 (C3): v_job_cost_events and v_supplier_credit_allocations read each crew party, credit share and
-- installer test once, with the same rows. Synthetic documents through the real views. Each expected figure is read
-- from the fixture documents by hand; then the earlier definitions (this migration's down, in a savepoint) must give
-- the very same rows. All fixture writes roll back. Self-run checks (Claude), no production.
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE c3_checks(name text, passed boolean);
CREATE FUNCTION pg_temp.prove(n text, p boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  IF p IS DISTINCT FROM true THEN RAISE EXCEPTION 'C3 cost view speed: %', n; END IF;
  INSERT INTO c3_checks VALUES (n, p);
END $$;
CREATE FUNCTION pg_temp.ev(b text, l text, amt numeric, jn text, j uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.v_bookkeeping_line_evidence_current (xero_invoice_id, xero_line_item_id, amount_ex_gst, allocation, job_number, job_id, evidenced, basis, revision, stream, emitted_at)
  VALUES (b, l, amt, 'job', jn, j, true, 'supplier_document_job_number', 'c3t-ledger-cost-r1', 'c3t-ledger-cost', '2026-11-01') $$;
CREATE FUNCTION pg_temp.cost(j uuid, doc text) RETURNS numeric LANGUAGE sql AS $$
  SELECT COALESCE(sum(amount_ex), 0) FROM public.v_job_cost_events WHERE job_id = j AND document_id = doc $$;

-- The new reads are in place: one keyed map of crew parties, one set of installer bills, one join for credit shares,
-- the allocations read once, and an index on the Xero bill id.
DO $structure$
DECLARE v text := pg_get_viewdef('public.v_job_cost_events'::regclass, true);
        s text := pg_get_viewdef('public.v_supplier_credit_allocations'::regclass, true);
BEGIN
  PERFORM pg_temp.prove('the cost view reads the crew list once (no scan of it per bill line)', v !~ 'FROM trade t_(sp|ev|tn)' AND v ~ 'trade_party AS');
  PERFORM pg_temp.prove('the cost view joins each bill''s credit share once (no scan of the credit list per line)', position('FROM bill_credit c' in v) = 0 AND v ~ 'bill_credit_one AS');
  PERFORM pg_temp.prove('the cost view decides installer bills once per bill', v ~ 'installer_bill AS' AND (length(v) - length(replace(v, 'job_cost_installer_bill(', ''))) / length('job_cost_installer_bill(') = 2);
  PERFORM pg_temp.prove('the cost view reads the supplier credit allocations once', (length(v) - length(replace(v, 'FROM v_supplier_credit_allocations', ''))) / length('FROM v_supplier_credit_allocations') = 1);
  PERFORM pg_temp.prove('allocations compute their credit shares and crew-bill test once per row', s ~ 'OFFSET 0\)\s+cs' AND (length(s) - length(replace(s, 'materials_ai_trade_mirror(', ''))) / length('materials_ai_trade_mirror(') = 1);
  PERFORM pg_temp.prove('bills are indexed by their Xero id alone', EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'xero_invoices_xero_invoice_id_idx'));
END $structure$;

DO $test$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  p uuid := 'c3000000-0000-4000-8000-000000000001'; q uuid := 'c3000000-0000-4000-8000-000000000002';
  crew uuid := 'c3000000-0000-4000-8000-000000000003'; ti uuid := 'c3000000-0000-4000-8000-000000000004';
  tl uuid := 'c3000000-0000-4000-8000-000000000005';
BEGIN
  INSERT INTO public.organisations (id, name) VALUES (org, 'Synthetic C3 organisation') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.jobs (id, org_id, status, type, job_number, metadata, pricing_json, created_at) VALUES
    (p, org, 'in_progress', 'fencing', 'SWT-99001', '{}', '{}', '2026-09-01'),
    (q, org, 'in_progress', 'patio', 'SWT-99002', '{}', '{}', '2026-09-01');
  INSERT INTO public.users (id, org_id, name) VALUES (crew, org, 'C3 Crew Alpha');
  -- A crew invoice line on P (250) and its own Xero bill, tracked to SW - PATIOS: the crew party of P is "c3 crew alpha".
  INSERT INTO public.trade_invoices (id, org_id, user_id, week_start, status, subtotal_ex, gst, total_inc, invoice_number, xero_bill_id,
                                     gst_on, super_rate, gross_earned, super_amount, net_pay)
  VALUES (ti, org, crew, '2026-08-24', 'approved', 250, 0, 250, 'SW-INV-C3T-1', 'b-c3crew', false, 0, 250, 0, 250);
  INSERT INTO public.trade_invoice_lines (id, trade_invoice_id, job_id, job_number, line_type, description, total_hours, hourly_rate, line_total_ex, line_date, created_at)
  VALUES (tl, ti, p, 'SWT-99001', 'labour', 'Labour', 5, 50, 250, '2026-08-25', '2026-08-30 01:00:00+00');
  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, job_id, raw_json, line_items) VALUES
    (org, 'b-c3crew', 'SW-INV-C3T-1', 'ACCPAY', 'AUTHORISED', 'C3 Crew Alpha', 250, 250, '2026-08-31', NULL, '{"LineAmountTypes": "NoTax"}',
     '[{"LineItemID": "cc1", "Description": "C3 Crew Alpha\nSWT-99001 | SW - PATIOS\nLabour 5h", "AccountCode": "306", "LineAmount": 250, "Tracking": [{"Name": "Business Unit", "Option": "SW - PATIOS"}]}]'),
    -- Installer bills (account 306) Bookkeeping places on P: one from P's own crew (stays off P), one from another installer.
    (org, 'b-c3-ev-crew', 'C3B-1', 'ACCPAY', 'AUTHORISED', 'C3 Crew Alpha Pty Ltd', 100, 100, '2026-09-02', NULL, '{"LineAmountTypes": "NoTax"}',
     '[{"LineItemID": "l1", "Description": "Install", "AccountCode": "306", "LineAmount": 100}]'),
    (org, 'b-c3-ev-other', 'C3B-2', 'ACCPAY', 'AUTHORISED', 'Other Installer', 200, 200, '2026-09-02', NULL, '{"LineAmountTypes": "NoTax"}',
     '[{"LineItemID": "l2", "Description": "Install", "AccountCode": "306", "LineAmount": 200}]'),
    -- The same as the first, with the account code a JSON number: still an installer bill, still off P.
    (org, 'b-c3-ev-crew-n', 'C3B-9', 'ACCPAY', 'AUTHORISED', 'C3 Crew Alpha Pty Ltd', 90, 90, '2026-09-02', NULL, '{"LineAmountTypes": "NoTax"}',
     '[{"LineItemID": "l9", "Description": "Install", "AccountCode": 306, "LineAmount": 90}]'),
    -- No evidence: the line's text names SWT-99001. P's own crew installing: off P. A supplier's materials line: on P.
    (org, 'b-c3-tn-crew', 'C3B-3', 'ACCPAY', 'AUTHORISED', 'C3 Crew Alpha', 300, 300, '2026-09-03', NULL, '{"LineAmountTypes": "NoTax"}',
     '[{"LineItemID": "l3", "Description": "Install SWT-99001 fence", "AccountCode": "306", "LineAmount": 300}]'),
    (org, 'b-c3-tn-goods', 'C3B-4', 'ACCPAY', 'AUTHORISED', 'Fence Hardware', 400, 400, '2026-09-03', NULL, '{"LineAmountTypes": "NoTax"}',
     '[{"LineItemID": "l4", "Description": "Posts for swt 99001", "AccountCode": "305", "LineAmount": 400}]'),
    -- A bill on P with a credit note listed (55 inc of a 550 bill; the note is 50 ex): 10% back, -50.
    (org, 'b-c3-credit', 'C3B-5', 'ACCPAY', 'PAID', 'Fence Hardware', 500, 550, '2026-09-04', p,
     '{"LineAmountTypes": "Exclusive", "AmountCredited": 55, "CreditNotes": [{"CreditNoteID": "cn-c3", "AppliedAmount": 55}]}',
     '[{"LineItemID": "l5", "Description": "Rails", "AccountCode": "305", "LineAmount": 500, "TaxAmount": 50}]'),
    -- A bill on Q a placement carries (1,000), credited by amount only (110 of 1,100): -100.
    (org, 'b-c3-fact', 'C3B-8', 'ACCPAY', 'PAID', 'Timber Yard', 1000, 1100, '2026-09-05', NULL,
     '{"LineAmountTypes": "Exclusive", "AmountCredited": 110}',
     '[{"LineItemID": "l8", "Description": "Timber", "AccountCode": "305", "LineAmount": 1000, "TaxAmount": 100}]'),
    -- A bill on Q with a credit note listed that our copy does not hold, nothing in AmountCredited: 11 inc at the bill's
    -- own rate (100 of 110) is 10 ex, 10% back, -10.
    (org, 'b-c3-list', 'C3B-10', 'ACCPAY', 'AUTHORISED', 'Timber Yard', 100, 110, '2026-09-06', q,
     '{"LineAmountTypes": "Exclusive", "AmountCredited": 0, "CreditNotes": [{"CreditNoteID": "cn-c3-missing", "AppliedAmount": 11}]}',
     '[{"LineItemID": "l10", "Description": "Screws", "AccountCode": "305", "LineAmount": 100, "TaxAmount": 10}]');
  PERFORM pg_temp.ev('b-c3-ev-crew', 'l1', 100, 'SWT-99001', p);
  PERFORM pg_temp.ev('b-c3-ev-other', 'l2', 200, 'SWT-99001', p);
  PERFORM pg_temp.ev('b-c3-ev-crew-n', 'l9', 90, 'SWT-99001', p);
  INSERT INTO public.job_materials_facts (org_id, xero_invoice_id, invoice_number, contact_name, job_id, job_number, lane, kind, amount_ex_gst, confidence, automation_source, fact_date)
  VALUES (org, 'b-c3-fact', 'C3B-8', 'Timber Yard', q, 'SWT-99002', 'materials', 'actual', 1000, 'high', 'agent_ai', '2026-09-05');
  INSERT INTO public.xero_supplier_credit_notes (org_id, xero_credit_note_id, credit_note_type, credit_note_number, contact_name, credit_note_date, status, line_amount_types, currency_code, sub_total, total_tax, total, remaining_credit, allocations_returned, xero_updated_at, raw_json) VALUES
    (org, 'cn-c3', 'ACCPAYCREDIT', 'CN-C3', 'Fence Hardware', '2026-09-10', 'PAID', 'Exclusive', 'AUD', 50, 5, 55, 0, true, '2026-09-10', '{}'),
    (org, 'cn-c3b', 'ACCPAYCREDIT', 'CN-C3B', 'C3 Crew Alpha', '2026-09-10', 'PAID', 'NoTax', 'AUD', 10, 0, 10, 0, true, '2026-09-10', '{}');
  INSERT INTO public.xero_supplier_credit_note_allocations (org_id, xero_credit_note_id, n, allocation_id, xero_invoice_id, invoice_number, amount, allocation_date, is_deleted, raw_json) VALUES
    (org, 'cn-c3', 1, 'al-c3', 'b-c3-credit', 'C3B-5', 55, '2026-09-10', false, '{}'),
    (org, 'cn-c3b', 1, 'al-c3b', 'b-c3crew', 'SW-INV-C3T-1', 10, '2026-09-10', false, '{}');

  PERFORM pg_temp.prove('an installer bill Bookkeeping places on the job stays off it when the job''s own crew sent it', pg_temp.cost(p, 'b-c3-ev-crew') = 0
    AND NOT EXISTS (SELECT 1 FROM public.v_job_cost_events WHERE document_id = 'b-c3-ev-crew'));
  PERFORM pg_temp.prove('the same with the account code written as a number', NOT EXISTS (SELECT 1 FROM public.v_job_cost_events WHERE document_id = 'b-c3-ev-crew-n'));
  PERFORM pg_temp.prove('another installer''s bill Bookkeeping places goes on the job', pg_temp.cost(p, 'b-c3-ev-other') = 200
    AND (SELECT match_method FROM public.v_job_cost_events WHERE document_id = 'b-c3-ev-other') = 'bookkeeping_evidence');
  PERFORM pg_temp.prove('an installer bill naming the job in its text stays off it when the job''s own crew sent it', NOT EXISTS (SELECT 1 FROM public.v_job_cost_events WHERE document_id = 'b-c3-tn-crew'));
  PERFORM pg_temp.prove('a supplier line naming the job in its text goes on the job', pg_temp.cost(p, 'b-c3-tn-goods') = 400
    AND (SELECT match_method FROM public.v_job_cost_events WHERE document_id = 'b-c3-tn-goods') = 'bill_line_job_number');
  PERFORM pg_temp.prove('a listed credit note takes its share off the bill (500 less 50)', pg_temp.cost(p, 'b-c3-credit') = 450
    AND (SELECT amount_ex FROM public.v_job_cost_events WHERE document_id = 'b-c3-credit' AND source = 'supplier_credit') = -50);
  PERFORM pg_temp.prove('a placement on a bill credited by amount carries the credit (1,000 less 100)', pg_temp.cost(q, 'b-c3-fact') = 900);
  PERFORM pg_temp.prove('a credit note listed but not in our copy is taken at the bill''s own rate (100 less 10)', pg_temp.cost(q, 'b-c3-list') = 90);
  PERFORM pg_temp.prove('the crew line keeps the division of its own Xero bill line', (SELECT business_unit FROM public.v_job_cost_events WHERE source_id = tl::text) = 'SW - PATIOS');
  PERFORM pg_temp.prove('Job Profit''s cost of P: crew 250, installer 200, goods 400, rails 500 less 50',
    (SELECT actual_cost_ex FROM public.v_job_profit WHERE job_id = p) = 1300);
  PERFORM pg_temp.prove('a credit note on a supplier bill counts on that bill', (SELECT state || '/' || bill_side FROM public.v_supplier_credit_allocations WHERE xero_credit_note_id = 'cn-c3') = 'bill_live/counts_it');
  PERFORM pg_temp.prove('a credit note on a crew bill is a crew bill''s', (SELECT state FROM public.v_supplier_credit_allocations WHERE xero_credit_note_id = 'cn-c3b') = 'crew_bill');
END $test$;

-- The earlier definitions (this migration's down, exactly) give the very same rows on these documents.
CREATE TEMP TABLE c3_new_cost AS SELECT * FROM public.v_job_cost_events;
CREATE TEMP TABLE c3_new_alloc AS SELECT * FROM public.v_supplier_credit_allocations;
CREATE TEMP TABLE c3_new_profit AS SELECT * FROM public.v_job_profit WHERE job_id IN ('c3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002');
SAVEPOINT c3_earlier;
\ir ../../../rollbacks/20261104123000_job_cost_events_faster_same_rows_down.sql
DO $same$
BEGIN
  IF (SELECT count(*) FROM c3_new_cost WHERE document_id LIKE 'b-c3%' OR document_id = 'c3000000-0000-4000-8000-000000000004') < 8 THEN
    RAISE EXCEPTION 'C3 cost view speed: the fixtures did not reach the cost view';
  END IF;
  IF EXISTS (SELECT * FROM c3_new_cost EXCEPT ALL SELECT * FROM public.v_job_cost_events)
     OR EXISTS (SELECT * FROM public.v_job_cost_events EXCEPT ALL SELECT * FROM c3_new_cost) THEN
    RAISE EXCEPTION 'C3 cost view speed: the earlier cost view gives other rows';
  END IF;
  IF EXISTS (SELECT * FROM c3_new_alloc EXCEPT ALL SELECT * FROM public.v_supplier_credit_allocations)
     OR EXISTS (SELECT * FROM public.v_supplier_credit_allocations EXCEPT ALL SELECT * FROM c3_new_alloc) THEN
    RAISE EXCEPTION 'C3 cost view speed: the earlier allocations give other rows';
  END IF;
  IF EXISTS (SELECT * FROM c3_new_profit EXCEPT ALL SELECT * FROM public.v_job_profit WHERE job_id IN ('c3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002'))
     OR EXISTS (SELECT * FROM public.v_job_profit WHERE job_id IN ('c3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002') EXCEPT ALL SELECT * FROM c3_new_profit) THEN
    RAISE EXCEPTION 'C3 cost view speed: the earlier Job Profit rows differ';
  END IF;
END $same$;
ROLLBACK TO SAVEPOINT c3_earlier;
INSERT INTO c3_checks VALUES ('the earlier definitions give the same cost, allocation and Job Profit rows', true);
SELECT jsonb_build_object('checks', count(*), 'passed', count(*) FILTER (WHERE passed)) AS result FROM c3_checks;
ROLLBACK;
