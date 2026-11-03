-- 20261104070000 (A6 rule 1): Bookkeeping split lines; an AI whole-bill fact stands aside.
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

  -- One Xero line 879.14 ex GST (967.05 inc) that the ledger splits 581.75 to A and 297.39 to B; an AI fact carries
  -- the whole bill on A.
  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, fully_paid_on, job_id, raw_json, line_items) VALUES
    (org, 'b-amp', 'W-AMP', 'ACCPAY', 'PAID', 'Sheet Supplier', 879.14, 967.05, '2026-10-01', '2026-10-01', NULL, '{"LineAmountTypes": "Inclusive"}',
     '[{"LineItemID": "l-amp", "Description": "Polycarbonate sheets", "AccountCode": "305", "LineAmount": 967.05, "TaxAmount": 87.91}]');
  INSERT INTO public.job_materials_facts (xero_invoice_id, job_id, lane, kind, amount_ex_gst, automation_source, fact_date)
  VALUES ('b-amp', a, 'materials', 'actual', 879.14, 'agent_ai', '2026-10-01');
  PERFORM pg_temp.prove('before the split is loaded the AI fact carries the whole bill on A', pg_temp.cost_doc(a, 'b-amp') = 879.14 AND pg_temp.cost_doc(b, 'b-amp') = 0);

  BEGIN
    PERFORM public.bookkeeping_evidence_add_parts('a6t-ledger-cost-r1', 'not-the-file', '[]'::jsonb);
    failed := false;
  EXCEPTION WHEN OTHERS THEN failed := SQLERRM LIKE 'evidence_revision_sha_mismatch%';
  END;
  PERFORM pg_temp.prove('parts load refuses a file that is not the released one', failed);
  BEGIN
    PERFORM public.bookkeeping_evidence_add_parts('a6t-ledger-cost-r0', 'sha-r0', '[]'::jsonb);
    failed := false;
  EXCEPTION WHEN OTHERS THEN failed := SQLERRM LIKE 'evidence_revision_not_open%';
  END;
  PERFORM pg_temp.prove('parts load refuses a superseded revision', failed);

  n := public.bookkeeping_evidence_add_parts('a6t-ledger-cost-r1', 'sha-r1', jsonb_build_array(
    jsonb_build_object('b', 'b-amp', 'l', 'l-amp', 'p', 1, 'n', 2, 's', 879.14, 'a', 581.75, 'j', 'A6-A', 'k', 'job', 'e', 'true', 'c', 'supplier_document_job_number', 'o', 'ledger_allocated'),
    jsonb_build_object('b', 'b-amp', 'l', 'l-amp', 'p', 2, 'n', 2, 's', 879.14, 'a', 297.39, 'j', 'A6-B', 'k', 'job', 'e', 'true', 'c', 'supplier_document_job_number', 'o', 'ledger_allocated')));
  PERFORM pg_temp.prove('parts load writes both parts', n = 2);
  PERFORM pg_temp.prove('parts load re-run writes nothing twice', public.bookkeeping_evidence_add_parts('a6t-ledger-cost-r1', 'sha-r1', jsonb_build_array(
    jsonb_build_object('b', 'b-amp', 'l', 'l-amp', 'p', 1, 'n', 2, 's', 879.14, 'a', 581.75, 'j', 'A6-A', 'k', 'job', 'e', 'true'))) = 0);
  PERFORM pg_temp.prove('split part 1 on A at its own amount', pg_temp.cost_doc(a, 'b-amp') = 581.75);
  PERFORM pg_temp.prove('split part 2 on B at its own amount', pg_temp.cost_doc(b, 'b-amp') = 297.39);
  PERFORM pg_temp.prove('the AI whole-bill fact stands aside', NOT EXISTS (SELECT 1 FROM public.v_job_cost_events WHERE document_id = 'b-amp' AND source = 'materials_fact'));
  PERFORM pg_temp.prove('split parts are supplier bill lines placed by the ledger with their own ids',
    (SELECT array_agg(source_id ORDER BY source_id) FROM public.v_job_cost_events WHERE document_id = 'b-amp' AND source = 'supplier_bill' AND match_method = 'bookkeeping_evidence')
      = ARRAY['b-amp:1:part1', 'b-amp:1:part2']);

  -- An incomplete split (part 1 of 2 only) is never used.
  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, job_id, raw_json, line_items) VALUES
    (org, 'b-inc', 'INC-1', 'ACCPAY', 'AUTHORISED', 'Sheet Supplier', 100, 110, '2026-10-02', NULL, '{"LineAmountTypes": "Exclusive"}',
     '[{"LineItemID": "l-inc", "Description": "Sheets", "AccountCode": "305", "LineAmount": 100, "TaxAmount": 10}]');
  PERFORM public.bookkeeping_evidence_add_parts('a6t-ledger-cost-r1', 'sha-r1', jsonb_build_array(
    jsonb_build_object('b', 'b-inc', 'l', 'l-inc', 'p', 1, 'n', 2, 's', 100, 'a', 60, 'j', 'A6-A', 'k', 'job', 'e', 'true')));
  PERFORM pg_temp.prove('an incomplete split places nothing', NOT EXISTS (SELECT 1 FROM public.v_job_cost_events WHERE document_id = 'b-inc'));

  -- Parts that no longer add up to the Xero line as we hold it are not used.
  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, job_id, raw_json, line_items) VALUES
    (org, 'b-chg', 'CHG-1', 'ACCPAY', 'AUTHORISED', 'Sheet Supplier', 120, 132, '2026-10-02', NULL, '{"LineAmountTypes": "Exclusive"}',
     '[{"LineItemID": "l-chg", "Description": "Sheets", "AccountCode": "305", "LineAmount": 120, "TaxAmount": 12}]');
  PERFORM public.bookkeeping_evidence_add_parts('a6t-ledger-cost-r1', 'sha-r1', jsonb_build_array(
    jsonb_build_object('b', 'b-chg', 'l', 'l-chg', 'p', 1, 'n', 2, 's', 100, 'a', 60, 'j', 'A6-A', 'k', 'job', 'e', 'true'),
    jsonb_build_object('b', 'b-chg', 'l', 'l-chg', 'p', 2, 'n', 2, 's', 100, 'a', 40, 'j', 'A6-B', 'k', 'job', 'e', 'true')));
  PERFORM pg_temp.prove('parts of a line that changed in Xero are not used', NOT EXISTS (SELECT 1 FROM public.v_job_cost_events WHERE document_id = 'b-chg'));

  -- The office's whole-bill job still wins over the ledger's line evidence, parts included.
  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, job_id, raw_json, line_items) VALUES
    (org, 'b-off', 'OFF-1', 'ACCPAY', 'AUTHORISED', 'Sheet Supplier', 200, 220, '2026-10-03', c, '{"LineAmountTypes": "Exclusive"}',
     '[{"LineItemID": "l-off", "Description": "Sheets", "AccountCode": "305", "LineAmount": 200, "TaxAmount": 20}]');
  PERFORM public.bookkeeping_evidence_add_parts('a6t-ledger-cost-r1', 'sha-r1', jsonb_build_array(
    jsonb_build_object('b', 'b-off', 'l', 'l-off', 'p', 1, 'n', 2, 's', 200, 'a', 120, 'j', 'A6-A', 'k', 'job', 'e', 'true'),
    jsonb_build_object('b', 'b-off', 'l', 'l-off', 'p', 2, 'n', 2, 's', 200, 'a', 80, 'j', 'A6-B', 'k', 'job', 'e', 'true')));
  PERFORM pg_temp.prove('an office whole-bill job keeps the whole line', pg_temp.cost_doc(c, 'b-off') = 200 AND pg_temp.cost_doc(a, 'b-off') = 0 AND pg_temp.cost_doc(b, 'b-off') = 0);

  -- A person's split still outranks the ledger.
  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, job_id, raw_json, line_items) VALUES
    (org, 'b-man', 'MAN-1', 'ACCPAY', 'AUTHORISED', 'Sheet Supplier', 300, 330, '2026-10-03', NULL, '{"LineAmountTypes": "Exclusive"}',
     '[{"LineItemID": "l-man", "Description": "Sheets", "AccountCode": "305", "LineAmount": 300, "TaxAmount": 30}]');
  INSERT INTO public.job_materials_facts (xero_invoice_id, job_id, lane, kind, amount_ex_gst, automation_source, fact_date)
  VALUES ('b-man', a, 'materials', 'actual', 200, 'manual_split', '2026-10-03'), ('b-man', b, 'materials', 'actual', 100, 'manual_split', '2026-10-03');
  PERFORM public.bookkeeping_evidence_add_parts('a6t-ledger-cost-r1', 'sha-r1', jsonb_build_array(
    jsonb_build_object('b', 'b-man', 'l', 'l-man', 'p', 1, 'n', 2, 's', 300, 'a', 150, 'j', 'A6-A', 'k', 'job', 'e', 'true'),
    jsonb_build_object('b', 'b-man', 'l', 'l-man', 'p', 2, 'n', 2, 's', 300, 'a', 150, 'j', 'A6-B', 'k', 'job', 'e', 'true')));
  PERFORM pg_temp.prove('a manual split outranks the ledger split', pg_temp.cost_doc(a, 'b-man') = 200 AND pg_temp.cost_doc(b, 'b-man') = 100
    AND NOT EXISTS (SELECT 1 FROM public.v_job_cost_events WHERE document_id = 'b-man' AND source = 'supplier_bill'));

  -- A two-line bill the ledger places line 1 on A and line 2 on B; an AI fact carried all of it on A.
  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, job_id, raw_json, line_items) VALUES
    (org, 'b-two', 'TWO-1', 'ACCPAY', 'AUTHORISED', 'Sheet Supplier', 150, 165, '2026-10-04', NULL, '{"LineAmountTypes": "Exclusive"}',
     '[{"LineItemID": "l-two-1", "Description": "Sheets", "AccountCode": "305", "LineAmount": 100, "TaxAmount": 10},
       {"LineItemID": "l-two-2", "Description": "Screws", "AccountCode": "305", "LineAmount": 50, "TaxAmount": 5}]');
  INSERT INTO public.job_materials_facts (xero_invoice_id, job_id, lane, kind, amount_ex_gst, automation_source, fact_date)
  VALUES ('b-two', a, 'materials', 'actual', 150, 'agent_ai', '2026-10-04');
  PERFORM pg_temp.ev('a6t-ledger-cost-r1', 'b-two', 'l-two-1', 100, 'job', 'A6-A', a, '2026-11-01');
  PERFORM pg_temp.ev('a6t-ledger-cost-r1', 'b-two', 'l-two-2', 50, 'job', 'A6-B', b, '2026-11-01');
  PERFORM pg_temp.prove('a bill the ledger splits by line follows its lines, not the AI fact', pg_temp.cost_doc(a, 'b-two') = 100 AND pg_temp.cost_doc(b, 'b-two') = 50
    AND NOT EXISTS (SELECT 1 FROM public.v_job_cost_events WHERE document_id = 'b-two' AND source = 'materials_fact'));

  -- A newer whole-line row for the split line (another current stream, emitted later) supersedes the parts.
  PERFORM pg_temp.ev('a6t-forward-cost-r1', 'b-amp', 'l-amp', 879.14, 'job', 'A6-C', c, '2026-11-02');
  PERFORM pg_temp.prove('a newer whole-line row supersedes the older split', pg_temp.cost_doc(c, 'b-amp') = 879.14 AND pg_temp.cost_doc(a, 'b-amp') = 0 AND pg_temp.cost_doc(b, 'b-amp') = 0);
  DELETE FROM public.v_bookkeeping_line_evidence_current WHERE revision = 'a6t-forward-cost-r1';
  PERFORM pg_temp.prove('the split is back once the newer row is gone', pg_temp.cost_doc(a, 'b-amp') = 581.75 AND pg_temp.cost_doc(b, 'b-amp') = 297.39);

  PERFORM pg_temp.prove('anon cannot read the parts', NOT has_table_privilege('anon', 'public.v_bookkeeping_line_parts_current', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.bookkeeping_line_evidence_parts', 'SELECT'));
  PERFORM pg_temp.prove('only the service role loads parts', has_function_privilege('service_role', 'public.bookkeeping_evidence_add_parts(text, text, jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.bookkeeping_evidence_add_parts(text, text, jsonb)', 'EXECUTE'));
END $test$;
SELECT jsonb_build_object('checks', count(*), 'passed', count(*) FILTER (WHERE passed)) AS result FROM a6_checks;
ROLLBACK;
