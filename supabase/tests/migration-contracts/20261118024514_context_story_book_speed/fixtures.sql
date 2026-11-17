-- Existing MB and TP13 fixture populations, retained here without personal labels.
-- No expected answers are copied: compare complete main and fast books below.
INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, legacy, metadata, pricing_json, created_at) VALUES
 ('5eb00000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'in_progress', 'fencing', 'MB-1', 'ZZTEST customer', false, '{}', '{}', '2026-07-01T00:00:00Z'),
 ('5eb00000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'MB-2', 'ZZTEST customer', false, '{}', '{}', '2026-07-01T00:00:00Z');
INSERT INTO public.users (id, org_id, name) VALUES ('5eb10000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'ZZTEST crew')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.job_documents (id, job_id, type, sent_at, created_at) VALUES
 ('5eb20000-0000-4000-8000-000000000001', '5eb00000-0000-4000-8000-000000000001', 'quote', '2026-07-05T00:00:00Z', '2026-07-05T00:00:00Z'),
 ('5eb20000-0000-4000-8000-000000000002', '5eb00000-0000-4000-8000-000000000002', 'quote', '2026-07-05T00:00:00Z', '2026-07-05T00:00:00Z');
INSERT INTO public.quote_revisions (job_id, job_document_id, version, sent_at, released_via, totals_snapshot_json, internal_cost_snapshot_json) VALUES
 ('5eb00000-0000-4000-8000-000000000001', '5eb20000-0000-4000-8000-000000000001', 1, '2026-07-05T00:00:00Z', 'send-quote/send',
  '{"total_inc_gst": 2200, "total_ex_gst": 2000}', '{"cost_estimates": {"labour_total": 600, "material_total": 400, "subcontract_commission_total": 0}}'),
 ('5eb00000-0000-4000-8000-000000000002', '5eb20000-0000-4000-8000-000000000002', 1, '2026-07-05T00:00:00Z', 'send-quote/send',
  '{"total_inc_gst": 1100, "total_ex_gst": 1000}', '{"cost_estimates": {"labour_total": 0, "material_total": 0, "subcontract_commission_total": 0}}');
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, amount_paid, amount_due,
  invoice_date, due_date, job_id, raw_json, line_items, updated_at) VALUES
 ('00000000-0000-0000-0000-000000000001', 'MB-INV-1', 'INV-MB1', 'ACCREC', 'AUTHORISED', 'ZZTEST customer', 2000, 2200, 1100, 1100, '2026-08-01', '2026-08-15',
  '5eb00000-0000-4000-8000-000000000001', '{}', '[{"LineAmount": 2000, "AccountCode": "200", "Description": "Fence"}]', '2026-08-01T00:00:00Z');
INSERT INTO public.trade_invoices (id, org_id, user_id, week_start, status, subtotal_ex, invoice_number, paid_at, gst_on, gst, total_inc, super_rate,
  super_amount, gross_earned, net_pay) VALUES
 ('5eb30000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', '5eb10000-0000-4000-8000-000000000001', '2026-08-03', 'paid', 600,
  'SW-INV-MB1', '2026-08-20', false, 0, 600, 0.12, 72, 600, 564);
INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, job_number, line_type, description, line_total_ex, total_hours, line_date) VALUES
 ('5eb30000-0000-4000-8000-000000000001', '5eb00000-0000-4000-8000-000000000001', NULL, 'labour', 'Fence labour', 600, 12, '2026-08-04');
INSERT INTO public.job_materials_facts (job_id, xero_invoice_id, invoice_number, contact_name, lane, kind, amount_ex_gst, confidence, fact_date, automation_source) VALUES
 ('5eb00000-0000-4000-8000-000000000001', 'MB-BILL-1', 'B-1', 'Fence Supplies', 'materials', 'actual', 350, 'high', '2026-08-02', 'manual_queue');
INSERT INTO public.purchase_orders (id, job_id, po_number, supplier_name, status, subtotal, total, created_at) VALUES
 ('5eb40000-0000-4000-8000-000000000001', '5eb00000-0000-4000-8000-000000000001', 'PO-MB1', 'Fence Supplies', 'sent', 80, 88, '2026-08-01T00:00:00Z');
INSERT INTO public.materials_reconciliation_queue (id, xero_invoice_id, invoice_number, sub_total, total, suggested_job_id, status, updated_at) VALUES
 ('5eb50000-0000-4000-8000-000000000001', 'MB-BILL-2', 'B-2', 120, 132, '5eb00000-0000-4000-8000-000000000001', 'open', '2026-08-03T00:00:00Z'),
 ('5eb50000-0000-4000-8000-000000000002', 'MB-BILL-3', 'B-3', 999, 1098.9, '5eb00000-0000-4000-8000-000000000001', 'not_job_related', '2026-08-03T00:00:00Z');
INSERT INTO public.job_client_signoffs (job_id, method, signed_name, happy, signature_media_id, waiver_reason, captured_by_actor, created_at)
SELECT '5eb00000-0000-4000-8000-000000000001', 'office_waiver', NULL, true, NULL, 'Customer away', 'user:test', '2026-08-20T03:00:00Z';

INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, pricing_json, expected_costs, created_at)
SELECT ('d1300000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, '00000000-0000-0000-0000-000000000001',
       'complete', 'fencing', 'TP13-' || lpad(n::text, 2, '0'), false, '{}', '{}',
       CASE WHEN n = 22 THEN '{"lanes": {"labour": {"amount_ex_gst": 500}, "materials": {"amount_ex_gst": 700}}}'::jsonb
            ELSE '{"lanes": {"labour": {"amount_ex_gst": 500}, "materials": {"amount_ex_gst": 700}, "commission": {"amount_ex_gst": 0}}}'::jsonb END,
       timestamptz '2026-08-01T00:00:00Z'
FROM unnest(ARRAY[1, 2, 3, 4, 5, 6, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]) n;

INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, line_items, raw_json, job_id)
SELECT '00000000-0000-0000-0000-000000000001', 'TP13-S-' || j.k, 'INV-TP13-' || j.k, 'ACCREC', 'AUTHORISED', 'TP13 Customer',
       j.ex, j.ex * 1.1, date '2026-08-25',
       jsonb_build_array(jsonb_build_object('Description', 'Fence', 'AccountCode', '200', 'LineAmount', j.ex, 'TaxAmount', j.ex * 0.1)),
       '{"LineAmountTypes": "Exclusive"}'::jsonb, j.id
FROM (SELECT id, right(job_number, 2) AS k,
             CASE job_number WHEN 'TP13-06' THEN 1500 WHEN 'TP13-19' THEN 1200 ELSE 2000 END::numeric AS ex
      FROM public.jobs WHERE job_number LIKE 'TP13-%') j;

-- Placed by a person (manual_queue): labour 500 and materials 600 unless named.
INSERT INTO public.job_materials_facts (job_id, xero_invoice_id, invoice_number, contact_name, lane, kind, amount_ex_gst, confidence, fact_date, automation_source)
SELECT j.id, 'TP13-L-' || right(j.job_number, 2), 'BL-TP13-' || right(j.job_number, 2), 'TP13 Installer', 'labour', 'actual', 500, 'high', date '2026-08-20', 'manual_queue'
FROM public.jobs j WHERE j.job_number LIKE 'TP13-%' AND j.job_number NOT IN ('TP13-05', 'TP13-15', 'TP13-16')
UNION ALL
SELECT j.id, 'TP13-M-' || right(j.job_number, 2), 'BM-TP13-' || right(j.job_number, 2), 'TP13 Steel', 'materials', 'actual',
       CASE j.job_number WHEN 'TP13-02' THEN 500 WHEN 'TP13-11' THEN 300 ELSE 600 END, 'high', date '2026-08-20', 'manual_queue'
FROM public.jobs j WHERE j.job_number LIKE 'TP13-%' AND j.job_number <> 'TP13-21';

-- Orders (12, 13, 14, 25) and the not-yet-overdue controls (03, 24).
INSERT INTO public.purchase_orders (id, org_id, job_id, po_number, supplier_name, source, status, subtotal, total, delivery_date, created_at, last_sent_at, invoice_received_at) VALUES
  ('d1310000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'd1300000-0000-4000-8000-000000000003', 'PO-TP13-03', 'TP13 Timber', NULL, 'sent', 100, 110,
   ((now() AT TIME ZONE 'Australia/Perth')::date - 10), now() - interval '12 days', now() - interval '12 days', NULL),
  ('d1310000-0000-4000-8000-000000000012', '00000000-0000-0000-0000-000000000001', 'd1300000-0000-4000-8000-000000000012', 'PO-TP13-12', 'TP13 Timber', NULL, 'sent', 100, 110,
   ((now() AT TIME ZONE 'Australia/Perth')::date - 45), now() - interval '50 days', now() - interval '50 days', NULL),
  ('d1310000-0000-4000-8000-000000000013', '00000000-0000-0000-0000-000000000001', 'd1300000-0000-4000-8000-000000000013', 'PO-TP13-13', 'TP13 Timber', NULL, 'sent', 0, 0,
   NULL, now() - interval '45 days', now() - interval '45 days', NULL),
  ('d1310000-0000-4000-8000-000000000014', '00000000-0000-0000-0000-000000000001', 'd1300000-0000-4000-8000-000000000014', 'PO-TP13-14', 'TP13 Timber', NULL, 'confirmed', 100, 110,
   NULL, now() - interval '60 days', now() - interval '60 days', now() - interval '40 days'),
  -- 01:00 in Perth is 17:00 UTC the day before: 29 Perth days old, 30 by the UTC day
  ('d1310000-0000-4000-8000-000000000024', '00000000-0000-0000-0000-000000000001', 'd1300000-0000-4000-8000-000000000024', 'PO-TP13-24', 'TP13 Timber', NULL, 'sent', 100, 110,
   NULL, (((now() AT TIME ZONE 'Australia/Perth')::date - 29) + time '01:00') AT TIME ZONE 'Australia/Perth', NULL, NULL),
  ('d1310000-0000-4000-8000-000000000025', '00000000-0000-0000-0000-000000000001', 'd1300000-0000-4000-8000-000000000025', 'PO-TP13-25', 'TP13 Timber', NULL, 'sent', 100, 110,
   NULL, (((now() AT TIME ZONE 'Australia/Perth')::date - 30) + time '01:00') AT TIME ZONE 'Australia/Perth', NULL, NULL);

-- Work done: completion (05, 15) and a client sign-off (16).
UPDATE public.jobs SET completed_at = now() - interval '5 days' WHERE job_number = 'TP13-05';
UPDATE public.jobs SET completed_at = now() - interval '20 days' WHERE job_number = 'TP13-15';
INSERT INTO public.job_client_signoffs (job_id, method, waiver_reason, captured_by_actor, created_at) VALUES
  ('d1300000-0000-4000-8000-000000000016', 'office_waiver', 'Customer away, office signed', 'contract@test', now() - interval '20 days');

-- Xero Project (17): named with the job number, more than the costs placed.
INSERT INTO public.xero_projects (job_id, project_name, total_expenses, total_invoiced) VALUES
  ('d1300000-0000-4000-8000-000000000017', 'TP13-17 work', 2000, 2200);

-- Sent quotes (04, 06, 19, 23): 1,320 inc GST, 1,200 ex.
INSERT INTO public.job_documents (id, job_id, type, sent_at, accepted_at, created_at)
SELECT ('d1320000-0000-4000-8000-0000000000' || n)::uuid, ('d1300000-0000-4000-8000-0000000000' || n)::uuid, 'quote',
       timestamptz '2026-07-20T00:00:00Z', timestamptz '2026-07-22T00:00:00Z', timestamptz '2026-07-20T00:00:00Z'
FROM unnest(ARRAY['04', '06', '19', '23']) n;
INSERT INTO public.quote_revisions (job_id, job_document_id, version, sent_at, released_via, totals_snapshot_json, internal_cost_snapshot_json)
SELECT ('d1300000-0000-4000-8000-0000000000' || n)::uuid, ('d1320000-0000-4000-8000-0000000000' || n)::uuid, 1, timestamptz '2026-07-20T00:00:00Z', 'send-quote/send',
       '{"total_inc_gst": 1320, "total_ex_gst": 1200}'::jsonb, '{"cost_estimates": {"labour_total": 500, "material_total": 700, "subcontract_commission_total": 0}}'::jsonb
FROM unnest(ARRAY['04', '06', '19', '23']) n;

-- Variations: 330 inc GST (300 ex) each.
INSERT INTO public.job_variations (id, job_id, variation_number, description, amount, gst_included, status, accepted_at, cost_estimate, created_at) VALUES
  ('d1330000-0000-4000-8000-000000000004', 'd1300000-0000-4000-8000-000000000004', 1, 'Extra panel', 330, true, 'accepted', '2026-08-10T00:00:00Z', 100, '2026-08-09T00:00:00Z'),
  ('d1330000-0000-4000-8000-000000000006', 'd1300000-0000-4000-8000-000000000006', 1, 'Extra panel', 330, true, 'accepted', '2026-08-10T00:00:00Z', 100, '2026-08-09T00:00:00Z'),
  ('d1330000-0000-4000-8000-000000000018', 'd1300000-0000-4000-8000-000000000018', 1, 'Extra panel', 330, true, 'accepted', '2026-08-10T00:00:00Z', NULL, '2026-08-09T00:00:00Z'),
  ('d1330000-0000-4000-8000-000000000019', 'd1300000-0000-4000-8000-000000000019', 1, 'Extra panel', 330, true, 'accepted', '2026-08-10T00:00:00Z', 100, '2026-08-09T00:00:00Z'),
  ('d1330000-0000-4000-8000-000000000020', 'd1300000-0000-4000-8000-000000000020', 1, 'Extra panel', 330, true, 'invoiced', NULL, 100, '2026-08-09T00:00:00Z'),
  ('d1330000-0000-4000-8000-000000000023', 'd1300000-0000-4000-8000-000000000023', 1, 'Extra panel', 330, true, 'accepted', '2026-08-10T00:00:00Z', 0, '2026-08-09T00:00:00Z'),
  -- a declined variation flags nothing
  ('d1330000-0000-4000-8000-000000000101', 'd1300000-0000-4000-8000-000000000001', 1, 'Gate', 550, true, 'declined', NULL, NULL, '2026-08-09T00:00:00Z');
UPDATE public.job_variations SET declined_at = '2026-08-11T00:00:00Z' WHERE id = 'd1330000-0000-4000-8000-000000000101';

