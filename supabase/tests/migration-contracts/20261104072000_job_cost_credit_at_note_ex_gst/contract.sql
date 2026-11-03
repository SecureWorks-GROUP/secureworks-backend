-- 20261104072000 (A6 rule 3): a supplier credit at the credit note's own ex-GST amount.
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

  -- Bunnings shape: lines 65.67, 3.64, 43.78, 21.59 ex (sub 134.68, total 148.15), all on D; credit note 91.32 ex
  -- GST (tax 9.12, total 100.44) applied in full. D's credit is -91.32, never 100.44 x 134.68 / 148.15 = 91.31.
  INSERT INTO public.xero_supplier_credit_notes (org_id, xero_credit_note_id, credit_note_type, credit_note_number, contact_name, credit_note_date, status, line_amount_types, currency_code, sub_total, total_tax, total, remaining_credit, allocations_returned, xero_updated_at, raw_json) VALUES
    (org, 'cn-bun', 'ACCPAYCREDIT', 'CN-BUN', 'Hardware Store', '2026-10-30', 'PAID', 'Exclusive', 'AUD', 91.32, 9.12, 100.44, 0, true, '2026-10-30', '{}'),
    (org, 'cn-bun4', 'ACCPAYCREDIT', 'CN-BUN4', 'Hardware Store', '2026-10-30', 'PAID', 'Exclusive', 'AUD', 91.32, 9.12, 100.44, 0, true, '2026-10-30', '{}'),
    (org, 'cn-bun5', 'ACCPAYCREDIT', 'CN-BUN5', 'Hardware Store', '2026-10-30', 'PAID', 'Exclusive', 'AUD', 91.32, 9.12, 100.44, 0, true, '2026-10-30',
     '{"LineItems": [{"LineItemID": "cnl-5", "AccountCode": "305", "LineAmount": 91.32}]}');
  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, job_id, raw_json, line_items)
  SELECT org, v.id, v.num, 'ACCPAY', 'PAID', 'Hardware Store', 134.68, 148.15, '2026-07-04', NULL, v.raw::jsonb,
    '[{"LineItemID": "x1", "Description": "Plastic film", "AccountCode": "305", "LineAmount": 65.67, "TaxAmount": 6.57},
      {"LineItemID": "x2", "Description": "Snap hook", "AccountCode": "305", "LineAmount": 3.64, "TaxAmount": 0.36},
      {"LineItemID": "x3", "Description": "Castor", "AccountCode": "305", "LineAmount": 43.78, "TaxAmount": 4.38},
      {"LineItemID": "x4", "Description": "Rope", "AccountCode": "305", "LineAmount": 21.59, "TaxAmount": 2.16},
      {"LineItemID": "x5", "Description": "Payment terms"}]'::jsonb
  FROM (VALUES
    ('b-bun', 'BUN-1', '{"LineAmountTypes": "Exclusive", "AmountCredited": 100.44, "CreditNotes": [{"CreditNoteID": "cn-bun", "AppliedAmount": 100.44}]}'),
    ('b-bun2', 'BUN-2', '{"LineAmountTypes": "Exclusive", "AmountCredited": 100.44, "CreditNotes": [{"CreditNoteID": "cn-not-in-copy", "AppliedAmount": 100.44}]}'),
    ('b-bun3', 'BUN-3', '{"LineAmountTypes": "Exclusive", "AmountCredited": 100.44}'),
    ('b-bun4', 'BUN-4', '{"LineAmountTypes": "Exclusive"}'),
    ('b-bun5', 'BUN-5', '{"LineAmountTypes": "Exclusive", "AmountCredited": 100.44, "CreditNotes": [{"CreditNoteID": "cn-bun5", "AppliedAmount": 100.44}]}')) v(id, num, raw);
  PERFORM pg_temp.ev('a6t-ledger-cost-r1', bb.id, l.id, l.amt, 'job', 'A6-D', d, '2026-11-01')
  FROM (VALUES ('b-bun'), ('b-bun2'), ('b-bun3'), ('b-bun4'), ('b-bun5')) bb(id)
  CROSS JOIN (VALUES ('x1', 65.67), ('x2', 3.64), ('x3', 43.78), ('x4', 21.59)) l(id, amt);
  INSERT INTO public.xero_supplier_credit_note_allocations (org_id, xero_credit_note_id, n, allocation_id, xero_invoice_id, invoice_number, amount, allocation_date, is_deleted, raw_json) VALUES
    (org, 'cn-bun', 1, 'al-1', 'b-bun', 'BUN-1', 100.44, '2026-10-30', false, '{}'),
    (org, 'cn-bun4', 1, 'al-4', 'b-bun4', 'BUN-4', 100.44, '2026-10-30', false, '{}'),
    (org, 'cn-bun5', 1, 'al-5', 'b-bun5', 'BUN-5', 100.44, '2026-10-30', false, '{}');

  PERFORM pg_temp.prove('credit at the credit note''s own ex GST: -91.32', pg_temp.cost_doc(d, 'b-bun') = 134.68 - 91.32);
  PERFORM pg_temp.prove('credit rows add up to the note''s cents (running-total rounding)',
    (SELECT array_agg(amount_ex ORDER BY source_id) FROM public.v_job_cost_events WHERE document_id = 'b-bun' AND source = 'supplier_credit')
      = ARRAY[-44.53, -2.47, -29.68, -14.64]::numeric[]);
  PERFORM pg_temp.prove('a credit note our copy does not hold is taken at the bill''s rate', pg_temp.cost_doc(d, 'b-bun2') = 134.68 - 91.31);
  PERFORM pg_temp.prove('a bill with no readable credit-note list keeps the AmountCredited rule', pg_temp.cost_doc(d, 'b-bun3') = 134.68 - 91.31);
  PERFORM pg_temp.prove('a credit only the credit note shows is taken at the note''s own ex GST', pg_temp.cost_doc(d, 'b-bun4') = 134.68 - 91.32);
  -- Bookkeeping places half the credit note (-45.66) on A: the bill keeps the other half at the note's rate.
  PERFORM pg_temp.ev('a6t-ledger-cost-r1', 'cn-bun5', 'cnl-5', -45.66, 'job', 'A6-A', a, '2026-11-01');
  PERFORM pg_temp.prove('the ledger''s share of a credit note moves to its job; the rest stays on the bill at the note''s rate',
    pg_temp.cost_doc(d, 'b-bun5') = 134.68 - 45.66 AND pg_temp.cost_doc(a, 'cn-bun5') = -45.66);
END $test$;
SELECT jsonb_build_object('checks', count(*), 'passed', count(*) FILTER (WHERE passed)) AS result FROM a6_checks;
ROLLBACK;
