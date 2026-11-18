-- The bills backfill twin. Everything below is rolled back.
BEGIN;
-- ONE fixture, checked on both sides: xero-sync/cost_lines_bill_backfill_fixture_test.ts
-- runs the edge billCostDocument over the same bills and asserts this exact text
-- is still here. Change them together.
CREATE TEMP TABLE twin_fixture ON COMMIT DROP AS SELECT $fixture$
{"org_id":"00000000-0000-0000-0000-000000000001","employer_super":true,"bills":[{"invoice_type":"ACCPAY","xero_contact_id":"ZZTEST-supplier","contact_name":"ZZTEST Supplier","xero_invoice_id":"ZZTEST-TWIN-1","status":"PAID","invoice_number":"ZZ-1","invoice_date":"2026-11-10","fully_paid_on":"2026-11-12","sub_total":140.45,"raw_json":{"LineAmountTypes":"Inclusive"},"line_items":[{"LineItemID":"zz-li-1","Description":"Posts","AccountCode":"300","LineAmount":100.5,"TaxAmount":9.14,"Tracking":[{"Name":"Division","Option":"Fencing"}]},{"Description":"Commission run","AccountCode":"306","LineAmount":"55.10","TaxAmount":"5.01"},{"LineItemID":"zz-li-3","Description":"Nothing","AccountCode":"400","LineAmount":0,"TaxAmount":0},{"LineItemID":"zz-li-4","Description":"Freight","AccountCode":429,"LineAmount":0.1,"TaxAmount":0.3}]},{"invoice_type":"ACCPAY","xero_contact_id":"ZZTEST-supplier","contact_name":"ZZTEST Supplier","xero_invoice_id":"ZZTEST-TWIN-2","status":"AUTHORISED","invoice_number":"ZZ-2","invoice_date":"2026-11-09","fully_paid_on":null,"sub_total":1253.33,"raw_json":{"LineAmountTypes":"Exclusive"},"line_items":[{"LineItemID":"zz-li-a","Description":"Labour week","AccountCode":"306","LineAmount":1000,"TaxAmount":100},{"LineItemID":"zz-li-b","Description":"Travel","AccountCode":"301","LineAmount":333.33,"TaxAmount":33.33},{"Description":"Superannuation withheld. Company contribution $80.17","AccountCode":"826","LineAmount":-80,"TaxAmount":0}]},{"invoice_type":"ACCPAY","xero_contact_id":"ZZTEST-supplier","contact_name":"ZZTEST Supplier","xero_invoice_id":"ZZTEST-TWIN-3","status":"DRAFT","invoice_number":"ZZ-3","invoice_date":"2026-11-08","fully_paid_on":null,"sub_total":250.75,"raw_json":{"LineAmountTypes":null},"line_items":[]},{"invoice_type":"ACCPAY","xero_contact_id":"ZZTEST-supplier","contact_name":"ZZTEST Supplier","xero_invoice_id":"ZZTEST-TWIN-4","status":"AUTHORISED","invoice_number":null,"invoice_date":"2026-11-07","fully_paid_on":null,"sub_total":null,"raw_json":{"LineAmountTypes":null},"line_items":null}],"expected":[{"org_id":"00000000-0000-0000-0000-000000000001","document_kind":"xero_bill","document_id":"ZZTEST-TWIN-1","document_number":"ZZ-1","document_date":"2026-11-10","document_status":"PAID","live":true,"party_kind":"supplier","party_id":"ZZTEST-supplier","party_name":"ZZTEST Supplier","lines":[{"line_key":"zz-li-1","line_no":1,"kind":"supplier_bill","description":"Posts","account_code":"300","xero_tracking_option":"Fencing","lane":"materials","event_lane_detail":"materials","amount_ex":91.36,"gst":9.14,"is_actual":true,"paid":true,"paid_on":"2026-11-12","event_source":"supplier_bill","event_source_id":"ZZTEST-TWIN-1:1"},{"line_key":"n:2","line_no":2,"kind":"installer_bill","description":"Commission run","account_code":"306","xero_tracking_option":null,"lane":"commission","event_lane_detail":"commission","amount_ex":50.09,"gst":5.01,"is_actual":true,"paid":true,"paid_on":"2026-11-12","event_source":"supplier_bill","event_source_id":"ZZTEST-TWIN-1:2"},{"line_key":"zz-li-4","line_no":4,"kind":"supplier_bill","description":"Freight","account_code":"429","xero_tracking_option":null,"lane":"other","event_lane_detail":"other","amount_ex":-0.19999999999999998,"gst":0.3,"is_actual":true,"paid":true,"paid_on":"2026-11-12","event_source":"supplier_bill","event_source_id":"ZZTEST-TWIN-1:4"}]},{"org_id":"00000000-0000-0000-0000-000000000001","document_kind":"xero_bill","document_id":"ZZTEST-TWIN-2","document_number":"ZZ-2","document_date":"2026-11-09","document_status":"AUTHORISED","live":true,"party_kind":"supplier","party_id":"ZZTEST-supplier","party_name":"ZZTEST Supplier","lines":[{"line_key":"zz-li-a","line_no":1,"kind":"installer_bill","description":"Labour week","account_code":"306","xero_tracking_option":null,"lane":"labour","event_lane_detail":"labour","amount_ex":1000,"gst":100,"is_actual":true,"paid":false,"paid_on":null,"event_source":"supplier_bill","event_source_id":"ZZTEST-TWIN-2:1"},{"line_key":"zz-li-b","line_no":2,"kind":"installer_bill","description":"Travel","account_code":"301","xero_tracking_option":null,"lane":"labour","event_lane_detail":"labour","amount_ex":333.33,"gst":33.33,"is_actual":true,"paid":false,"paid_on":null,"event_source":"supplier_bill","event_source_id":"ZZTEST-TWIN-2:2"},{"line_key":"zz-li-a:employer_super","line_no":1,"kind":"employer_super","description":"Employer super on: Labour week","account_code":"306","xero_tracking_option":null,"lane":"labour","event_lane_detail":"employer_super","amount_ex":60.12765,"gst":0,"is_actual":true,"paid":false,"paid_on":null,"event_source":"bill_employer_super","event_source_id":"ZZTEST-TWIN-2:1:employer_super","follows_line_key":"zz-li-a"},{"line_key":"zz-li-b:employer_super","line_no":2,"kind":"employer_super","description":"Employer super on: Travel","account_code":"301","xero_tracking_option":null,"lane":"labour","event_lane_detail":"employer_super","amount_ex":20.04235,"gst":0,"is_actual":true,"paid":false,"paid_on":null,"event_source":"bill_employer_super","event_source_id":"ZZTEST-TWIN-2:2:employer_super","follows_line_key":"zz-li-b"}]},{"org_id":"00000000-0000-0000-0000-000000000001","document_kind":"xero_bill","document_id":"ZZTEST-TWIN-3","document_number":"ZZ-3","document_date":"2026-11-08","document_status":"DRAFT","live":false,"party_kind":"supplier","party_id":"ZZTEST-supplier","party_name":"ZZTEST Supplier","lines":[{"line_key":"n:1","line_no":1,"kind":"supplier_bill","description":"Bill total (no lines stored)","account_code":null,"xero_tracking_option":null,"lane":"other","event_lane_detail":"other","amount_ex":250.75,"gst":0,"is_actual":true,"paid":false,"paid_on":null,"event_source":"supplier_bill","event_source_id":"ZZTEST-TWIN-3:1"}]},{"org_id":"00000000-0000-0000-0000-000000000001","document_kind":"xero_bill","document_id":"ZZTEST-TWIN-4","document_number":null,"document_date":"2026-11-07","document_status":"AUTHORISED","live":true,"party_kind":"supplier","party_id":"ZZTEST-supplier","party_name":"ZZTEST Supplier","lines":[{"line_key":"n:1","line_no":1,"kind":"supplier_bill","description":"Bill total (no lines stored)","account_code":null,"xero_tracking_option":null,"lane":"other","event_lane_detail":"other","amount_ex":null,"gst":0,"is_actual":true,"paid":false,"paid_on":null,"event_source":"supplier_bill","event_source_id":"ZZTEST-TWIN-4:1"}]}]}
$fixture$::jsonb AS f;

-- 1. Parity: the SQL document equals the edge document, text for text (the
--    source hash reads the line's jsonb text, so numbers must match exactly).
DO $$
DECLARE f jsonb := (SELECT f FROM twin_fixture); i int; got jsonb; want jsonb;
BEGIN
  FOR i IN 0 .. jsonb_array_length(f->'bills') - 1 LOOP
    got := public.job_cost_lines_bill_document((f->>'org_id')::uuid, f->'bills'->i, true);
    want := f->'expected'->i;
    IF got::text IS DISTINCT FROM want::text THEN
      RAISE EXCEPTION 'twin: bill % differs from the edge document: % <> %', i, got, want;
    END IF;
  END LOOP;
  -- Employer super off: the same bill without its employer super lines.
  got := public.job_cost_lines_bill_document((f->>'org_id')::uuid, f->'bills'->1, false);
  IF jsonb_array_length(got->'lines') <> 2
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(got->'lines') l WHERE l->>'kind' = 'employer_super') THEN
    RAISE EXCEPTION 'twin: employer super written with the switch off'; END IF;
  -- Only a supplier bill makes a document.
  IF public.job_cost_lines_bill_document((f->>'org_id')::uuid,
       (f->'bills'->0) || '{"invoice_type":"ACCREC"}', true) IS NOT NULL THEN
    RAISE EXCEPTION 'twin: a sales invoice made a cost document'; END IF;
END;
$$;

-- 2. The backfill over synced rows: window, newest first, cursor, mirrors,
--    idempotence, and a bill the edge sync already wrote is not rewritten.
UPDATE public.feature_flags SET enabled = true
  WHERE flag_name IN ('job_cost_lines_sync_v1', 'job_cost_employer_super_v1');
DO $$
BEGIN
  IF (SELECT count(*) FROM public.feature_flags WHERE flag_name IN
      ('job_cost_lines_sync_v1', 'job_cost_employer_super_v1') AND enabled) <> 2 THEN
    RAISE EXCEPTION 'twin: the two switch rows are missing from the stack'; END IF;
END;
$$;
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status,
  xero_contact_id, contact_name, sub_total, invoice_date, fully_paid_on, line_items, raw_json)
SELECT (f->>'org_id')::uuid, b->>'xero_invoice_id', b->>'invoice_number', b->>'invoice_type', b->>'status',
  b->>'xero_contact_id', b->>'contact_name', (b->>'sub_total')::numeric, (b->>'invoice_date')::date,
  (b->>'fully_paid_on')::date,
  CASE WHEN jsonb_typeof(b->'line_items') = 'null' THEN NULL ELSE b->'line_items' END, b->'raw_json'
FROM twin_fixture, jsonb_array_elements(f->'bills') b;
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status,
  xero_contact_id, contact_name, sub_total, invoice_date, line_items, raw_json) VALUES
  -- A sales invoice and a bill outside the window: never read.
  ('00000000-0000-0000-0000-000000000001', 'ZZTEST-TWIN-5', 'ZZ-5', 'ACCREC', 'AUTHORISED',
   'ZZTEST-customer', 'ZZTEST Customer', 10, date '2026-11-08',
   '[{"LineItemID":"zz-s-1","AccountCode":"200","LineAmount":10,"TaxAmount":1}]', '{}'),
  ('00000000-0000-0000-0000-000000000001', 'ZZTEST-TWIN-6', 'ZZ-6', 'ACCPAY', 'AUTHORISED',
   'ZZTEST-supplier', 'ZZTEST Supplier', 10, date '2026-10-01',
   '[{"LineItemID":"zz-o-1","AccountCode":"300","LineAmount":10,"TaxAmount":1}]', '{}'),
  -- A crew bill mirrored by a trade invoice: read, skipped.
  ('00000000-0000-0000-0000-000000000001', 'ZZTEST-TWIN-7', 'ZZ-7', 'ACCPAY', 'AUTHORISED',
   'ZZTEST-crew', 'ZZTEST Crew', 500, date '2026-11-06',
   '[{"LineItemID":"zz-m-1","AccountCode":"306","LineAmount":500,"TaxAmount":50}]', '{}');
INSERT INTO public.trade_invoices (xero_bill_id, status, subtotal_ex, gst, total_inc, gst_on, super_rate,
  super_amount, gross_earned, net_pay, super_basis)
VALUES ('ZZTEST-TWIN-7', 'pushed_to_xero', 500, 0, 500, false, 0.12, 60, 500, 500, 'employer_12_v2');

DO $$
DECLARE f jsonb := (SELECT f FROM twin_fixture); org uuid := (f->>'org_id')::uuid; r jsonb;
BEGIN
  IF (SELECT count(*) FROM public.xero_invoices WHERE org_id = org AND invoice_type = 'ACCPAY'
      AND invoice_date BETWEEN '2026-11-06' AND '2026-11-10') <> 5 THEN
    RAISE EXCEPTION 'twin: the stack holds other bills in the test window'; END IF;
  -- The edge sync already wrote bill 2 (the TS document): the twin must not rewrite it.
  PERFORM public.job_cost_lines_upsert_documents(jsonb_build_array(f->'expected'->1));

  r := public.job_cost_lines_backfill_bills(org, '2026-11-06', '2026-11-10', 2);
  IF r->>'ran' <> 'true' OR (r->>'bills_read')::int <> 2 OR (r->>'documents')::int <> 2
     OR (r->>'lines_written')::int <> 3 OR (r->>'done')::boolean
     OR r->'next_before' <> '{"invoice_date":"2026-11-09","xero_invoice_id":"ZZTEST-TWIN-2"}'::jsonb THEN
    RAISE EXCEPTION 'twin: first page wrong: %', r; END IF;
  r := public.job_cost_lines_backfill_bills(org, '2026-11-06', '2026-11-10', 2, '2026-11-09', 'ZZTEST-TWIN-2');
  IF (r->>'bills_read')::int <> 2 OR (r->>'lines_written')::int <> 2 OR (r->>'done')::boolean
     OR r->'next_before' <> '{"invoice_date":"2026-11-07","xero_invoice_id":"ZZTEST-TWIN-4"}'::jsonb THEN
    RAISE EXCEPTION 'twin: second page wrong: %', r; END IF;
  r := public.job_cost_lines_backfill_bills(org, '2026-11-06', '2026-11-10', 2, '2026-11-07', 'ZZTEST-TWIN-4');
  IF (r->>'bills_read')::int <> 1 OR (r->>'mirrors_skipped')::int <> 1 OR (r->>'documents')::int <> 0
     OR NOT (r->>'done')::boolean OR r->'next_before' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'twin: last page wrong: %', r; END IF;
  -- Idempotent: the whole window again writes nothing.
  r := public.job_cost_lines_backfill_bills(org, '2026-11-06', '2026-11-10');
  IF (r->>'bills_read')::int <> 5 OR (r->>'lines_written')::int <> 0 OR (r->>'documents_changed')::int <> 0
     OR NOT (r->>'done')::boolean THEN
    RAISE EXCEPTION 'twin: second run wrote: %', r; END IF;
  -- What was written: the sync's own lines, cents as the sync stores them.
  IF (SELECT array_agg(line_key || '=' || amount_ex ORDER BY line_key) FROM public.job_cost_lines
      WHERE document_kind = 'xero_bill' AND document_id = 'ZZTEST-TWIN-1')
     IS DISTINCT FROM ARRAY['n:2=50.09', 'zz-li-1=91.36', 'zz-li-4=-0.20'] THEN
    RAISE EXCEPTION 'twin: bill 1 lines wrong'; END IF;
  IF (SELECT count(*) FROM public.job_cost_lines WHERE document_kind = 'xero_bill'
      AND document_id = 'ZZTEST-TWIN-2' AND kind = 'employer_super') <> 2 THEN
    RAISE EXCEPTION 'twin: bill 2 employer super lines missing'; END IF;
  IF EXISTS (SELECT 1 FROM public.job_cost_lines WHERE document_id IN
      ('ZZTEST-TWIN-5', 'ZZTEST-TWIN-6', 'ZZTEST-TWIN-7')) THEN
    RAISE EXCEPTION 'twin: a sales, out-of-window or mirrored bill was written'; END IF;
  IF (SELECT state FROM public.job_cost_lines WHERE document_id = 'ZZTEST-TWIN-3') IS NOT NULL
     OR (SELECT not_counted_reason FROM public.job_cost_lines WHERE document_id = 'ZZTEST-TWIN-3')
        IS DISTINCT FROM 'document_not_live' THEN
    RAISE EXCEPTION 'twin: a draft bill counted'; END IF;

  -- Arguments: refused, nothing read.
  BEGIN PERFORM public.job_cost_lines_backfill_bills(org, '2026-11-06', '2026-11-10', 201);
    RAISE EXCEPTION 'twin: limit 201 accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.job_cost_lines_backfill_bills(org, '2026-11-10', '2026-11-06');
    RAISE EXCEPTION 'twin: a reversed window accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.job_cost_lines_backfill_bills(org, NULL, '2026-11-06');
    RAISE EXCEPTION 'twin: an open window accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.job_cost_lines_backfill_bills(org, '2026-11-06', '2026-11-10', 2, '2026-11-09');
    RAISE EXCEPTION 'twin: half a cursor accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;

  -- The sync switch off: nothing read, nothing written.
  UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'job_cost_lines_sync_v1';
  r := public.job_cost_lines_backfill_bills(org, '2026-11-06', '2026-11-10');
  IF r <> '{"ran":false,"reason":"switch_off"}'::jsonb THEN
    RAISE EXCEPTION 'twin: ran with the sync switch off: %', r; END IF;
END;
$$;

-- 3. Database owner only: no grant to PUBLIC, anon, authenticated or service_role.
DO $$
DECLARE fn text; who text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.job_cost_bill_number(jsonb)',
    'public.job_cost_bill_json(double precision)',
    'public.job_cost_lines_bill_document(uuid,jsonb,boolean)',
    'public.job_cost_lines_backfill_bills(uuid,date,date,integer,date,text)'] LOOP
    FOREACH who IN ARRAY ARRAY['public', 'anon', 'authenticated', 'service_role'] LOOP
      IF has_function_privilege(who, fn, 'EXECUTE') THEN
        RAISE EXCEPTION 'twin: % may run %', who, fn; END IF;
    END LOOP;
  END LOOP;
END;
$$;
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    PERFORM public.job_cost_lines_backfill_bills('00000000-0000-0000-0000-000000000001', '2026-11-06', '2026-11-10');
    RAISE EXCEPTION 'twin: service_role ran the backfill';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.job_cost_lines_bill_document('00000000-0000-0000-0000-000000000001', '{}', false);
    RAISE EXCEPTION 'twin: service_role ran the document builder';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$$;
RESET ROLE;
ROLLBACK;
