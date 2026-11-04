-- 20261104091000 (A3): a credit applied to a customer invoice carries that invoice's one division.
-- Synthetic invoices through the real v_job_revenue_events; every expected division is read from the fixture lines
-- by hand. All fixture writes roll back. Self-run checks (Claude), no production.
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE a3c_checks(name text, passed boolean);
CREATE FUNCTION pg_temp.prove(n text, p boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  IF p IS DISTINCT FROM true THEN RAISE EXCEPTION 'A3 credit division: %', n; END IF;
  INSERT INTO a3c_checks VALUES (n, p);
END $$;
CREATE FUNCTION pg_temp.credit(d text) RETURNS TABLE (bu text, amt numeric, d date) LANGUAGE sql AS $$
  SELECT business_unit, amount_ex, invoice_date FROM public.v_job_revenue_events WHERE source_id = d || ':credit' $$;

DO $test$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  j uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.organisations (id, name) VALUES (org, 'Synthetic A3 organisation') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.jobs (id, org_id, status, type, job_number, metadata, pricing_json, created_at) VALUES
    (j, org, 'in_progress', 'patio', 'SW9346', '{}', '{}', '2026-07-01');
  -- i1: both lines with an amount tracked SW - PATIOS (a zero note line untracked); 110.00 of 1,100.00 credited.
  -- i2: one line SW - PATIOS, one SW - FENCING. i3: one line untracked.
  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, job_id, raw_json, line_items)
  SELECT org, v.id, v.num, 'ACCREC', 'AUTHORISED', 'Synthetic customer', 1000, 1100, '2026-08-03', j,
    '{"LineAmountTypes": "Exclusive", "CreditNotes": [{"CreditNoteID": "cn-a3", "AppliedAmount": 110}]}'::jsonb, v.lines::jsonb
  FROM (VALUES
    ('i-a3-1', 'A3C-1', '[{"LineItemID": "a", "AccountCode": "208", "LineAmount": 600, "TaxAmount": 60, "Tracking": [{"Name": "Business Unit", "Option": "SW - PATIOS"}]},
                         {"LineItemID": "b", "AccountCode": "208", "LineAmount": 400, "TaxAmount": 40, "Tracking": [{"Name": "Business Unit", "Option": "SW - PATIOS"}]},
                         {"LineItemID": "c", "Description": "Note", "LineAmount": 0}]'),
    ('i-a3-2', 'A3C-2', '[{"LineItemID": "a", "AccountCode": "208", "LineAmount": 600, "TaxAmount": 60, "Tracking": [{"Name": "Business Unit", "Option": "SW - PATIOS"}]},
                         {"LineItemID": "b", "AccountCode": "207", "LineAmount": 400, "TaxAmount": 40, "Tracking": [{"Name": "Business Unit", "Option": "SW - FENCING"}]}]'),
    ('i-a3-3', 'A3C-3', '[{"LineItemID": "a", "AccountCode": "208", "LineAmount": 600, "TaxAmount": 60, "Tracking": [{"Name": "Business Unit", "Option": "SW - PATIOS"}]},
                         {"LineItemID": "b", "AccountCode": "208", "LineAmount": 400, "TaxAmount": 40}]')) v(id, num, lines);
  PERFORM pg_temp.prove('a credit on an invoice with one division takes it, amount and date unchanged',
    (SELECT bu = 'SW - PATIOS' AND amt = -100.00 AND d = '2026-08-03' FROM pg_temp.credit('i-a3-1')));
  PERFORM pg_temp.prove('a credit on an invoice with two divisions takes none', (SELECT bu IS NULL FROM pg_temp.credit('i-a3-2')));
  PERFORM pg_temp.prove('a credit on an invoice with an untracked line of value takes none', (SELECT bu IS NULL FROM pg_temp.credit('i-a3-3')));
  PERFORM pg_temp.prove('one credit row per invoice, invoice lines unchanged',
    (SELECT count(*) FROM public.v_job_revenue_events WHERE document_id IN ('i-a3-1', 'i-a3-2', 'i-a3-3') AND kind = 'credit_applied') = 3
    AND (SELECT count(*) FROM public.v_job_revenue_events WHERE document_id = 'i-a3-1' AND kind = 'invoice_line' AND business_unit = 'SW - PATIOS') = 2);
END $test$;
SELECT jsonb_build_object('checks', count(*), 'passed', count(*) FILTER (WHERE passed)) AS result FROM a3c_checks;
ROLLBACK;
