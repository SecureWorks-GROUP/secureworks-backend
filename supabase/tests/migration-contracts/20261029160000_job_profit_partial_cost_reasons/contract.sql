-- Contract for 20261029160000_job_profit_partial_cost_reasons (TP-13).
--
-- Synthetic jobs, no customer data. Everything rolls back. A blind sample of
-- 18 finished fencing jobs, each invoiced (2,000 ex unless named), with labour
-- 500 and materials 600 placed (a person placed both), and an expected cost
-- frozen at acceptance of labour 500, materials 700, commission 0. The answer
-- key (tp13_key) is written from how each job was built, never read off the
-- view: which jobs are partial (a bill or an invoice is still missing), the
-- reason the engine must name, whether it may publish a margin, and the
-- profit it must publish when it may.
--
--   TP13-01  complete                                  margin 900
--   TP13-02  materials 450 of 700 (64%, above 60%)     margin 1,050
--   TP13-03  priced order, delivery 10 days ago        open_purchase_orders, margin shown
--   TP13-04  variation accepted, costed, its invoice   margin 900
--   TP13-05  completed 5 days ago, no labour           no_labour_linked, not overdue
--   TP13-06  quote 1,200 ex + variation 300 ex, invoiced 1,500: covered   margin 400
--   TP13-11  materials 300 of 700 (43%)                materials_below_quote
--   TP13-12  priced order, delivery 45 days ago        po_no_bill_overdue
--   TP13-13  unpriced order sent 45 days ago           ordered_not_billed_over_30_days (now holds the margin)
--   TP13-14  supplier invoice emailed 40 days ago      po_no_bill_overdue
--   TP13-15  completed 20 days ago, no labour          work_done_no_labour_overdue
--   TP13-16  signed off (office waiver) 20 days ago, no labour  work_done_no_labour_overdue
--   TP13-17  Xero Project 2,000 against 1,100 placed   xero_project_exceeds_line_costs
--   TP13-18  variation accepted, no cost figure        variation_not_costed
--   TP13-19  quote 1,200 ex + variation 300 ex, invoiced 1,200   variation_not_invoiced
--   TP13-20  variation status 'invoiced', no invoice, no quote   variation_not_invoiced
--   TP13-21  no materials placed                       materials_not_linked (existing)
--   TP13-22  expected cost with no commission lane     expected_cost_lane_missing, margin 900
--
-- Dated cases sit at 5, 10, 20, 40 and 45 days from the run, well clear of
-- the 14 and 30 day limits, so no assertion depends on the hour it runs.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, pricing_json, expected_costs, created_at) VALUES
  ('d1300000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'TP13-01', false, '{}', '{}', '{"lanes": {"labour": {"amount_ex_gst": 500}, "materials": {"amount_ex_gst": 700}, "commission": {"amount_ex_gst": 0}}}', '2026-08-01T00:00:00Z'),
  ('d1300000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'TP13-02', false, '{}', '{}', '{"lanes": {"labour": {"amount_ex_gst": 500}, "materials": {"amount_ex_gst": 700}, "commission": {"amount_ex_gst": 0}}}', '2026-08-01T00:00:00Z'),
  ('d1300000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'TP13-03', false, '{}', '{}', '{"lanes": {"labour": {"amount_ex_gst": 500}, "materials": {"amount_ex_gst": 700}, "commission": {"amount_ex_gst": 0}}}', '2026-08-01T00:00:00Z'),
  ('d1300000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'TP13-04', false, '{}', '{}', '{"lanes": {"labour": {"amount_ex_gst": 500}, "materials": {"amount_ex_gst": 700}, "commission": {"amount_ex_gst": 0}}}', '2026-08-01T00:00:00Z'),
  ('d1300000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'TP13-05', false, '{}', '{}', '{"lanes": {"labour": {"amount_ex_gst": 500}, "materials": {"amount_ex_gst": 700}, "commission": {"amount_ex_gst": 0}}}', '2026-08-01T00:00:00Z'),
  ('d1300000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'TP13-06', false, '{}', '{}', '{"lanes": {"labour": {"amount_ex_gst": 500}, "materials": {"amount_ex_gst": 700}, "commission": {"amount_ex_gst": 0}}}', '2026-08-01T00:00:00Z'),
  ('d1300000-0000-4000-8000-000000000011', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'TP13-11', false, '{}', '{}', '{"lanes": {"labour": {"amount_ex_gst": 500}, "materials": {"amount_ex_gst": 700}, "commission": {"amount_ex_gst": 0}}}', '2026-08-01T00:00:00Z'),
  ('d1300000-0000-4000-8000-000000000012', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'TP13-12', false, '{}', '{}', '{"lanes": {"labour": {"amount_ex_gst": 500}, "materials": {"amount_ex_gst": 700}, "commission": {"amount_ex_gst": 0}}}', '2026-08-01T00:00:00Z'),
  ('d1300000-0000-4000-8000-000000000013', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'TP13-13', false, '{}', '{}', '{"lanes": {"labour": {"amount_ex_gst": 500}, "materials": {"amount_ex_gst": 700}, "commission": {"amount_ex_gst": 0}}}', '2026-08-01T00:00:00Z'),
  ('d1300000-0000-4000-8000-000000000014', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'TP13-14', false, '{}', '{}', '{"lanes": {"labour": {"amount_ex_gst": 500}, "materials": {"amount_ex_gst": 700}, "commission": {"amount_ex_gst": 0}}}', '2026-08-01T00:00:00Z'),
  ('d1300000-0000-4000-8000-000000000015', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'TP13-15', false, '{}', '{}', '{"lanes": {"labour": {"amount_ex_gst": 500}, "materials": {"amount_ex_gst": 700}, "commission": {"amount_ex_gst": 0}}}', '2026-08-01T00:00:00Z'),
  ('d1300000-0000-4000-8000-000000000016', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'TP13-16', false, '{}', '{}', '{"lanes": {"labour": {"amount_ex_gst": 500}, "materials": {"amount_ex_gst": 700}, "commission": {"amount_ex_gst": 0}}}', '2026-08-01T00:00:00Z'),
  ('d1300000-0000-4000-8000-000000000017', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'TP13-17', false, '{}', '{}', '{"lanes": {"labour": {"amount_ex_gst": 500}, "materials": {"amount_ex_gst": 700}, "commission": {"amount_ex_gst": 0}}}', '2026-08-01T00:00:00Z'),
  ('d1300000-0000-4000-8000-000000000018', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'TP13-18', false, '{}', '{}', '{"lanes": {"labour": {"amount_ex_gst": 500}, "materials": {"amount_ex_gst": 700}, "commission": {"amount_ex_gst": 0}}}', '2026-08-01T00:00:00Z'),
  ('d1300000-0000-4000-8000-000000000019', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'TP13-19', false, '{}', '{}', '{"lanes": {"labour": {"amount_ex_gst": 500}, "materials": {"amount_ex_gst": 700}, "commission": {"amount_ex_gst": 0}}}', '2026-08-01T00:00:00Z'),
  ('d1300000-0000-4000-8000-000000000020', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'TP13-20', false, '{}', '{}', '{"lanes": {"labour": {"amount_ex_gst": 500}, "materials": {"amount_ex_gst": 700}, "commission": {"amount_ex_gst": 0}}}', '2026-08-01T00:00:00Z'),
  ('d1300000-0000-4000-8000-000000000021', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'TP13-21', false, '{}', '{}', '{"lanes": {"labour": {"amount_ex_gst": 500}, "materials": {"amount_ex_gst": 700}, "commission": {"amount_ex_gst": 0}}}', '2026-08-01T00:00:00Z'),
  ('d1300000-0000-4000-8000-000000000022', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'TP13-22', false, '{}', '{}', '{"lanes": {"labour": {"amount_ex_gst": 500}, "materials": {"amount_ex_gst": 700}}}', '2026-08-01T00:00:00Z');

INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, line_items, raw_json, job_id) VALUES
  ('00000000-0000-0000-0000-000000000001', 'TP13-S-01', 'INV-TP13-01', 'ACCREC', 'AUTHORISED', 'TP13 Customer', 2000, 2200.0, '2026-08-25', '[{"Description": "Fence", "AccountCode": "200", "LineAmount": 2000, "TaxAmount": 200.0}]', '{"LineAmountTypes": "Exclusive"}', 'd1300000-0000-4000-8000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'TP13-S-02', 'INV-TP13-02', 'ACCREC', 'AUTHORISED', 'TP13 Customer', 2000, 2200.0, '2026-08-25', '[{"Description": "Fence", "AccountCode": "200", "LineAmount": 2000, "TaxAmount": 200.0}]', '{"LineAmountTypes": "Exclusive"}', 'd1300000-0000-4000-8000-000000000002'),
  ('00000000-0000-0000-0000-000000000001', 'TP13-S-03', 'INV-TP13-03', 'ACCREC', 'AUTHORISED', 'TP13 Customer', 2000, 2200.0, '2026-08-25', '[{"Description": "Fence", "AccountCode": "200", "LineAmount": 2000, "TaxAmount": 200.0}]', '{"LineAmountTypes": "Exclusive"}', 'd1300000-0000-4000-8000-000000000003'),
  ('00000000-0000-0000-0000-000000000001', 'TP13-S-04', 'INV-TP13-04', 'ACCREC', 'AUTHORISED', 'TP13 Customer', 2000, 2200.0, '2026-08-25', '[{"Description": "Fence", "AccountCode": "200", "LineAmount": 2000, "TaxAmount": 200.0}]', '{"LineAmountTypes": "Exclusive"}', 'd1300000-0000-4000-8000-000000000004'),
  ('00000000-0000-0000-0000-000000000001', 'TP13-S-05', 'INV-TP13-05', 'ACCREC', 'AUTHORISED', 'TP13 Customer', 2000, 2200.0, '2026-08-25', '[{"Description": "Fence", "AccountCode": "200", "LineAmount": 2000, "TaxAmount": 200.0}]', '{"LineAmountTypes": "Exclusive"}', 'd1300000-0000-4000-8000-000000000005'),
  ('00000000-0000-0000-0000-000000000001', 'TP13-S-06', 'INV-TP13-06', 'ACCREC', 'AUTHORISED', 'TP13 Customer', 1500, 1650.0, '2026-08-25', '[{"Description": "Fence", "AccountCode": "200", "LineAmount": 1500, "TaxAmount": 150.0}]', '{"LineAmountTypes": "Exclusive"}', 'd1300000-0000-4000-8000-000000000006'),
  ('00000000-0000-0000-0000-000000000001', 'TP13-S-11', 'INV-TP13-11', 'ACCREC', 'AUTHORISED', 'TP13 Customer', 2000, 2200.0, '2026-08-25', '[{"Description": "Fence", "AccountCode": "200", "LineAmount": 2000, "TaxAmount": 200.0}]', '{"LineAmountTypes": "Exclusive"}', 'd1300000-0000-4000-8000-000000000011'),
  ('00000000-0000-0000-0000-000000000001', 'TP13-S-12', 'INV-TP13-12', 'ACCREC', 'AUTHORISED', 'TP13 Customer', 2000, 2200.0, '2026-08-25', '[{"Description": "Fence", "AccountCode": "200", "LineAmount": 2000, "TaxAmount": 200.0}]', '{"LineAmountTypes": "Exclusive"}', 'd1300000-0000-4000-8000-000000000012'),
  ('00000000-0000-0000-0000-000000000001', 'TP13-S-13', 'INV-TP13-13', 'ACCREC', 'AUTHORISED', 'TP13 Customer', 2000, 2200.0, '2026-08-25', '[{"Description": "Fence", "AccountCode": "200", "LineAmount": 2000, "TaxAmount": 200.0}]', '{"LineAmountTypes": "Exclusive"}', 'd1300000-0000-4000-8000-000000000013'),
  ('00000000-0000-0000-0000-000000000001', 'TP13-S-14', 'INV-TP13-14', 'ACCREC', 'AUTHORISED', 'TP13 Customer', 2000, 2200.0, '2026-08-25', '[{"Description": "Fence", "AccountCode": "200", "LineAmount": 2000, "TaxAmount": 200.0}]', '{"LineAmountTypes": "Exclusive"}', 'd1300000-0000-4000-8000-000000000014'),
  ('00000000-0000-0000-0000-000000000001', 'TP13-S-15', 'INV-TP13-15', 'ACCREC', 'AUTHORISED', 'TP13 Customer', 2000, 2200.0, '2026-08-25', '[{"Description": "Fence", "AccountCode": "200", "LineAmount": 2000, "TaxAmount": 200.0}]', '{"LineAmountTypes": "Exclusive"}', 'd1300000-0000-4000-8000-000000000015'),
  ('00000000-0000-0000-0000-000000000001', 'TP13-S-16', 'INV-TP13-16', 'ACCREC', 'AUTHORISED', 'TP13 Customer', 2000, 2200.0, '2026-08-25', '[{"Description": "Fence", "AccountCode": "200", "LineAmount": 2000, "TaxAmount": 200.0}]', '{"LineAmountTypes": "Exclusive"}', 'd1300000-0000-4000-8000-000000000016'),
  ('00000000-0000-0000-0000-000000000001', 'TP13-S-17', 'INV-TP13-17', 'ACCREC', 'AUTHORISED', 'TP13 Customer', 2000, 2200.0, '2026-08-25', '[{"Description": "Fence", "AccountCode": "200", "LineAmount": 2000, "TaxAmount": 200.0}]', '{"LineAmountTypes": "Exclusive"}', 'd1300000-0000-4000-8000-000000000017'),
  ('00000000-0000-0000-0000-000000000001', 'TP13-S-18', 'INV-TP13-18', 'ACCREC', 'AUTHORISED', 'TP13 Customer', 2000, 2200.0, '2026-08-25', '[{"Description": "Fence", "AccountCode": "200", "LineAmount": 2000, "TaxAmount": 200.0}]', '{"LineAmountTypes": "Exclusive"}', 'd1300000-0000-4000-8000-000000000018'),
  ('00000000-0000-0000-0000-000000000001', 'TP13-S-19', 'INV-TP13-19', 'ACCREC', 'AUTHORISED', 'TP13 Customer', 1200, 1320.0, '2026-08-25', '[{"Description": "Fence", "AccountCode": "200", "LineAmount": 1200, "TaxAmount": 120.0}]', '{"LineAmountTypes": "Exclusive"}', 'd1300000-0000-4000-8000-000000000019'),
  ('00000000-0000-0000-0000-000000000001', 'TP13-S-20', 'INV-TP13-20', 'ACCREC', 'AUTHORISED', 'TP13 Customer', 2000, 2200.0, '2026-08-25', '[{"Description": "Fence", "AccountCode": "200", "LineAmount": 2000, "TaxAmount": 200.0}]', '{"LineAmountTypes": "Exclusive"}', 'd1300000-0000-4000-8000-000000000020'),
  ('00000000-0000-0000-0000-000000000001', 'TP13-S-21', 'INV-TP13-21', 'ACCREC', 'AUTHORISED', 'TP13 Customer', 2000, 2200.0, '2026-08-25', '[{"Description": "Fence", "AccountCode": "200", "LineAmount": 2000, "TaxAmount": 200.0}]', '{"LineAmountTypes": "Exclusive"}', 'd1300000-0000-4000-8000-000000000021'),
  ('00000000-0000-0000-0000-000000000001', 'TP13-S-22', 'INV-TP13-22', 'ACCREC', 'AUTHORISED', 'TP13 Customer', 2000, 2200.0, '2026-08-25', '[{"Description": "Fence", "AccountCode": "200", "LineAmount": 2000, "TaxAmount": 200.0}]', '{"LineAmountTypes": "Exclusive"}', 'd1300000-0000-4000-8000-000000000022');

INSERT INTO public.job_materials_facts (job_id, xero_invoice_id, invoice_number, contact_name, lane, kind, amount_ex_gst, confidence, fact_date, automation_source) VALUES
  ('d1300000-0000-4000-8000-000000000001', 'TP13-L-01', 'BL-TP13-01', 'TP13 Installer', 'labour', 'actual', 500, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000001', 'TP13-M-01', 'BM-TP13-01', 'TP13 Steel', 'materials', 'actual', 600, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000002', 'TP13-L-02', 'BL-TP13-02', 'TP13 Installer', 'labour', 'actual', 500, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000002', 'TP13-M-02', 'BM-TP13-02', 'TP13 Steel', 'materials', 'actual', 450, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000003', 'TP13-L-03', 'BL-TP13-03', 'TP13 Installer', 'labour', 'actual', 500, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000003', 'TP13-M-03', 'BM-TP13-03', 'TP13 Steel', 'materials', 'actual', 600, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000004', 'TP13-L-04', 'BL-TP13-04', 'TP13 Installer', 'labour', 'actual', 500, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000004', 'TP13-M-04', 'BM-TP13-04', 'TP13 Steel', 'materials', 'actual', 600, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000005', 'TP13-M-05', 'BM-TP13-05', 'TP13 Steel', 'materials', 'actual', 600, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000006', 'TP13-L-06', 'BL-TP13-06', 'TP13 Installer', 'labour', 'actual', 500, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000006', 'TP13-M-06', 'BM-TP13-06', 'TP13 Steel', 'materials', 'actual', 600, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000011', 'TP13-L-11', 'BL-TP13-11', 'TP13 Installer', 'labour', 'actual', 500, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000011', 'TP13-M-11', 'BM-TP13-11', 'TP13 Steel', 'materials', 'actual', 300, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000012', 'TP13-L-12', 'BL-TP13-12', 'TP13 Installer', 'labour', 'actual', 500, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000012', 'TP13-M-12', 'BM-TP13-12', 'TP13 Steel', 'materials', 'actual', 600, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000013', 'TP13-L-13', 'BL-TP13-13', 'TP13 Installer', 'labour', 'actual', 500, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000013', 'TP13-M-13', 'BM-TP13-13', 'TP13 Steel', 'materials', 'actual', 600, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000014', 'TP13-L-14', 'BL-TP13-14', 'TP13 Installer', 'labour', 'actual', 500, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000014', 'TP13-M-14', 'BM-TP13-14', 'TP13 Steel', 'materials', 'actual', 600, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000015', 'TP13-M-15', 'BM-TP13-15', 'TP13 Steel', 'materials', 'actual', 600, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000016', 'TP13-M-16', 'BM-TP13-16', 'TP13 Steel', 'materials', 'actual', 600, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000017', 'TP13-L-17', 'BL-TP13-17', 'TP13 Installer', 'labour', 'actual', 500, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000017', 'TP13-M-17', 'BM-TP13-17', 'TP13 Steel', 'materials', 'actual', 600, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000018', 'TP13-L-18', 'BL-TP13-18', 'TP13 Installer', 'labour', 'actual', 500, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000018', 'TP13-M-18', 'BM-TP13-18', 'TP13 Steel', 'materials', 'actual', 600, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000019', 'TP13-L-19', 'BL-TP13-19', 'TP13 Installer', 'labour', 'actual', 500, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000019', 'TP13-M-19', 'BM-TP13-19', 'TP13 Steel', 'materials', 'actual', 600, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000020', 'TP13-L-20', 'BL-TP13-20', 'TP13 Installer', 'labour', 'actual', 500, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000020', 'TP13-M-20', 'BM-TP13-20', 'TP13 Steel', 'materials', 'actual', 600, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000021', 'TP13-L-21', 'BL-TP13-21', 'TP13 Installer', 'labour', 'actual', 500, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000022', 'TP13-L-22', 'BL-TP13-22', 'TP13 Installer', 'labour', 'actual', 500, 'high', '2026-08-20', 'manual_queue'),
  ('d1300000-0000-4000-8000-000000000022', 'TP13-M-22', 'BM-TP13-22', 'TP13 Steel', 'materials', 'actual', 600, 'high', '2026-08-20', 'manual_queue');

-- Orders (12, 13, 14) and the not-yet-overdue control (03).
INSERT INTO public.purchase_orders (id, org_id, job_id, po_number, supplier_name, source, status, subtotal, total, delivery_date, created_at, last_sent_at, invoice_received_at) VALUES
  ('d1310000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'd1300000-0000-4000-8000-000000000003', 'PO-TP13-03', 'TP13 Timber', NULL, 'sent', 100, 110,
   ((now() AT TIME ZONE 'Australia/Perth')::date - 10), now() - interval '12 days', now() - interval '12 days', NULL),
  ('d1310000-0000-4000-8000-000000000012', '00000000-0000-0000-0000-000000000001', 'd1300000-0000-4000-8000-000000000012', 'PO-TP13-12', 'TP13 Timber', NULL, 'sent', 100, 110,
   ((now() AT TIME ZONE 'Australia/Perth')::date - 45), now() - interval '50 days', now() - interval '50 days', NULL),
  ('d1310000-0000-4000-8000-000000000013', '00000000-0000-0000-0000-000000000001', 'd1300000-0000-4000-8000-000000000013', 'PO-TP13-13', 'TP13 Timber', NULL, 'sent', 0, 0,
   NULL, now() - interval '45 days', now() - interval '45 days', NULL),
  ('d1310000-0000-4000-8000-000000000014', '00000000-0000-0000-0000-000000000001', 'd1300000-0000-4000-8000-000000000014', 'PO-TP13-14', 'TP13 Timber', NULL, 'confirmed', 100, 110,
   NULL, now() - interval '60 days', now() - interval '60 days', now() - interval '40 days');

-- Work done: completion (05, 15) and a client sign-off (16).
UPDATE public.jobs SET completed_at = now() - interval '5 days' WHERE job_number = 'TP13-05';
UPDATE public.jobs SET completed_at = now() - interval '20 days' WHERE job_number = 'TP13-15';
INSERT INTO public.job_client_signoffs (job_id, method, waiver_reason, captured_by_actor, created_at) VALUES
  ('d1300000-0000-4000-8000-000000000016', 'office_waiver', 'Customer away, office signed', 'contract@test', now() - interval '20 days');

-- Xero Project (17): named with the job number, more than the costs placed.
INSERT INTO public.xero_projects (job_id, project_name, total_expenses, total_invoiced) VALUES
  ('d1300000-0000-4000-8000-000000000017', 'TP13-17 Fence Rd', 2000, 2200);

-- Sent quotes (06, 19): 1,320 inc GST, 1,200 ex.
INSERT INTO public.job_documents (id, job_id, type, sent_at, accepted_at, created_at) VALUES
  ('d1320000-0000-4000-8000-000000000006', 'd1300000-0000-4000-8000-000000000006', 'quote', '2026-07-20T00:00:00Z', '2026-07-22T00:00:00Z', '2026-07-20T00:00:00Z'),
  ('d1320000-0000-4000-8000-000000000019', 'd1300000-0000-4000-8000-000000000019', 'quote', '2026-07-20T00:00:00Z', '2026-07-22T00:00:00Z', '2026-07-20T00:00:00Z');
INSERT INTO public.quote_revisions (job_id, job_document_id, version, sent_at, released_via, totals_snapshot_json, internal_cost_snapshot_json) VALUES
  ('d1300000-0000-4000-8000-000000000006', 'd1320000-0000-4000-8000-000000000006', 1, '2026-07-20T00:00:00Z', 'send-quote/send',
   '{"total_inc_gst": 1320, "total_ex_gst": 1200}', '{"cost_estimates": {"labour_total": 500, "material_total": 700, "subcontract_commission_total": 0}}'),
  ('d1300000-0000-4000-8000-000000000019', 'd1320000-0000-4000-8000-000000000019', 1, '2026-07-20T00:00:00Z', 'send-quote/send',
   '{"total_inc_gst": 1320, "total_ex_gst": 1200}', '{"cost_estimates": {"labour_total": 500, "material_total": 700, "subcontract_commission_total": 0}}');

-- Variations: 330 inc GST (300 ex) each.
INSERT INTO public.job_variations (id, job_id, variation_number, description, amount, gst_included, status, accepted_at, cost_estimate, xero_invoice_id, created_at) VALUES
  ('d1330000-0000-4000-8000-000000000004', 'd1300000-0000-4000-8000-000000000004', 1, 'Extra panel', 330, true, 'accepted', '2026-08-10T00:00:00Z', 100, 'TP13-S-04', '2026-08-09T00:00:00Z'),
  ('d1330000-0000-4000-8000-000000000006', 'd1300000-0000-4000-8000-000000000006', 1, 'Extra panel', 330, true, 'accepted', '2026-08-10T00:00:00Z', 100, NULL, '2026-08-09T00:00:00Z'),
  ('d1330000-0000-4000-8000-000000000018', 'd1300000-0000-4000-8000-000000000018', 1, 'Extra panel', 330, true, 'accepted', '2026-08-10T00:00:00Z', NULL, 'TP13-S-18', '2026-08-09T00:00:00Z'),
  ('d1330000-0000-4000-8000-000000000019', 'd1300000-0000-4000-8000-000000000019', 1, 'Extra panel', 330, true, 'accepted', '2026-08-10T00:00:00Z', 100, NULL, '2026-08-09T00:00:00Z'),
  ('d1330000-0000-4000-8000-000000000020', 'd1300000-0000-4000-8000-000000000020', 1, 'Extra panel', 330, true, 'invoiced', NULL, 100, NULL, '2026-08-09T00:00:00Z'),
  -- a declined variation flags nothing
  ('d1330000-0000-4000-8000-000000000101', 'd1300000-0000-4000-8000-000000000001', 1, 'Gate', 550, true, 'declined', NULL, NULL, NULL, '2026-08-09T00:00:00Z');
UPDATE public.job_variations SET declined_at = '2026-08-11T00:00:00Z' WHERE id = 'd1330000-0000-4000-8000-000000000101';

-- ── The answer key ─────────────────────────────────────────────────────────
CREATE TEMP TABLE tp13_key (job_number text PRIMARY KEY, partial boolean, want_reason text, want_margin boolean,
                            want_cost_flag text, want_profit numeric) ON COMMIT DROP;
INSERT INTO tp13_key VALUES
  ('TP13-01', false, NULL,                              true,  'ok', 900),
  ('TP13-02', false, NULL,                              true,  'ok', 1050),
  ('TP13-03', true,  'open_purchase_orders',            true,  'ok', 900),
  ('TP13-04', false, NULL,                              true,  'ok', 900),
  ('TP13-05', true,  'no_labour_linked',                false, 'no_labour_linked', NULL),
  ('TP13-06', false, NULL,                              true,  'ok', 400),
  ('TP13-11', true,  'materials_below_quote',           false, 'materials_below_quote', NULL),
  ('TP13-12', true,  'po_no_bill_overdue',              false, 'po_no_bill_overdue', NULL),
  ('TP13-13', true,  'ordered_not_billed_over_30_days', false, 'ordered_not_billed_over_30_days', NULL),
  ('TP13-14', true,  'po_no_bill_overdue',              false, 'po_no_bill_overdue', NULL),
  ('TP13-15', true,  'work_done_no_labour_overdue',     false, 'no_labour_linked', NULL),
  ('TP13-16', true,  'work_done_no_labour_overdue',     false, 'no_labour_linked', NULL),
  ('TP13-17', true,  'xero_project_exceeds_line_costs', false, 'xero_project_exceeds_line_costs', NULL),
  ('TP13-18', true,  'variation_not_costed',            false, 'variation_not_costed', NULL),
  ('TP13-19', true,  'variation_not_invoiced',          false, 'ok', NULL),
  ('TP13-20', true,  'variation_not_invoiced',          false, 'ok', NULL),
  ('TP13-21', true,  'materials_not_linked',            false, 'materials_not_linked', NULL),
  ('TP13-22', false, 'expected_cost_lane_missing',      true,  'ok', 900);

-- ── The numbers ────────────────────────────────────────────────────────────
DO $$
DECLARE p jsonb := public.job_profit_partial_cost_policy();
BEGIN
  IF p IS DISTINCT FROM '{"version": "tp13-v1", "po_no_bill_days": 30, "work_done_no_labour_days": 14, "materials_below_quote_share": 0.6, "variation_cover_tolerance_ex": 1.00}'::jsonb THEN
    RAISE EXCEPTION 'tp13 policy: %', p;
  END IF;
  IF has_function_privilege('anon', 'public.job_profit_partial_cost_policy()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.job_profit_partial_cost_policy()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.job_profit_partial_cost_policy()', 'EXECUTE') THEN
    RAISE EXCEPTION 'tp13 policy: grants are not service role only';
  END IF;
  IF has_table_privilege('anon', 'public.v_job_profit', 'SELECT')
     OR has_table_privilege('authenticated', 'public.v_job_profit', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.v_job_profit', 'SELECT') THEN
    RAISE EXCEPTION 'tp13 grants: v_job_profit is not service role only';
  END IF;
END $$;

-- ── Fixture sanity: the sample is built as the key says ───────────────────
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'TP13-19';
  IF r.quoted_ex IS DISTINCT FROM 1200::numeric OR r.variations_listed_ex IS DISTINCT FROM 300::numeric OR r.invoiced_ex <> 1200 THEN
    RAISE EXCEPTION 'tp13 fixture: TP13-19 quoted % variations % invoiced %', r.quoted_ex, r.variations_listed_ex, r.invoiced_ex;
  END IF;
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'TP13-11';
  IF r.actual_materials_ex <> 300 OR r.expected_materials_ex <> 700 OR r.actual_labour_ex <> 500 THEN
    RAISE EXCEPTION 'tp13 fixture: TP13-11 materials % of %, labour %', r.actual_materials_ex, r.expected_materials_ex, r.actual_labour_ex;
  END IF;
  IF (SELECT count(*) FROM public.v_job_profit v JOIN tp13_key k USING (job_number)) <> 18 THEN
    RAISE EXCEPTION 'tp13 fixture: the sample is not 18 jobs';
  END IF;
END $$;

-- ── The blind sample ───────────────────────────────────────────────────────
-- Every partial job names its reason, and the margin is published exactly
-- when the key allows it, with the profit the key says.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT k.*, v.completeness, v.margin_ok, v.cost_flag, v.profit_ex, v.margin_pct, v.profit_ex_unsuppressed, v.revenue_flag
    FROM tp13_key k JOIN public.v_job_profit v USING (job_number) ORDER BY k.job_number
  LOOP
    IF r.want_reason IS NOT NULL AND NOT (r.want_reason = ANY (r.completeness)) THEN
      RAISE EXCEPTION 'tp13 blind sample: % does not name % (completeness %)', r.job_number, r.want_reason, r.completeness;
    END IF;
    IF r.partial AND cardinality(r.completeness) = 0 THEN
      RAISE EXCEPTION 'tp13 blind sample: % is partial and names no reason', r.job_number;
    END IF;
    IF r.margin_ok IS DISTINCT FROM r.want_margin THEN
      RAISE EXCEPTION 'tp13 blind sample: % margin_ok %, expected % (completeness %)', r.job_number, r.margin_ok, r.want_margin, r.completeness;
    END IF;
    IF r.cost_flag IS DISTINCT FROM r.want_cost_flag THEN
      RAISE EXCEPTION 'tp13 blind sample: % cost_flag %, expected %', r.job_number, r.cost_flag, r.want_cost_flag;
    END IF;
    IF r.profit_ex IS DISTINCT FROM r.want_profit THEN
      RAISE EXCEPTION 'tp13 blind sample: % profit %, expected %', r.job_number, r.profit_ex, r.want_profit;
    END IF;
    IF NOT r.want_margin AND r.margin_pct IS NOT NULL THEN
      RAISE EXCEPTION 'tp13 blind sample: % publishes a margin % while a cost is missing', r.job_number, r.margin_pct;
    END IF;
    IF r.revenue_flag <> 'ok' THEN
      RAISE EXCEPTION 'tp13 blind sample: % revenue_flag % (only ok or missing_client_invoice, and every job is invoiced)', r.job_number, r.revenue_flag;
    END IF;
    -- A job that is not partial carries no TP-13 hold.
    IF NOT r.partial AND r.completeness && ARRAY['materials_below_quote', 'po_no_bill_overdue', 'work_done_no_labour_overdue',
                                                  'variation_not_costed', 'variation_not_invoiced', 'ordered_not_billed_over_30_days'] THEN
      RAISE EXCEPTION 'tp13 blind sample: complete job % carries %', r.job_number, r.completeness;
    END IF;
  END LOOP;
END $$;

-- ── Exact shapes ───────────────────────────────────────────────────────────
DO $$
DECLARE r record;
BEGIN
  -- Every earlier reason keeps its place; TP-13 codes come after.
  SELECT completeness INTO r FROM public.v_job_profit WHERE job_number = 'TP13-14';
  IF r.completeness IS DISTINCT FROM ARRAY['invoice_emailed_bill_not_placed', 'po_no_bill_overdue'] THEN
    RAISE EXCEPTION 'tp13 shape: TP13-14 completeness %', r.completeness;
  END IF;
  SELECT completeness INTO r FROM public.v_job_profit WHERE job_number = 'TP13-03';
  IF r.completeness IS DISTINCT FROM ARRAY['open_purchase_orders'] THEN
    RAISE EXCEPTION 'tp13 shape: an order 10 days old is overdue (%)', r.completeness;
  END IF;
  SELECT completeness INTO r FROM public.v_job_profit WHERE job_number = 'TP13-05';
  IF r.completeness IS DISTINCT FROM ARRAY['no_labour_linked'] THEN
    RAISE EXCEPTION 'tp13 shape: work done 5 days ago is overdue (%)', r.completeness;
  END IF;
  SELECT completeness INTO r FROM public.v_job_profit WHERE job_number = 'TP13-15';
  IF r.completeness IS DISTINCT FROM ARRAY['no_labour_linked', 'work_done_no_labour_overdue'] THEN
    RAISE EXCEPTION 'tp13 shape: TP13-15 completeness %', r.completeness;
  END IF;
  SELECT completeness INTO r FROM public.v_job_profit WHERE job_number = 'TP13-13';
  IF r.completeness IS DISTINCT FROM ARRAY['ordered_not_billed', 'ordered_not_billed_over_30_days'] THEN
    RAISE EXCEPTION 'tp13 shape: TP13-13 completeness % (an unpriced order is not also po_no_bill_overdue)', r.completeness;
  END IF;
  SELECT completeness INTO r FROM public.v_job_profit WHERE job_number = 'TP13-22';
  IF r.completeness IS DISTINCT FROM ARRAY['expected_cost_lane_missing'] THEN
    RAISE EXCEPTION 'tp13 shape: TP13-22 completeness %', r.completeness;
  END IF;
  -- Expected, committed and actual stay apart: no figure moves.
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'TP13-22';
  IF r.expected_cost_ex IS DISTINCT FROM 1200::numeric OR r.expected_commission_ex IS NOT NULL THEN
    RAISE EXCEPTION 'tp13 shape: TP13-22 expected % (commission %)', r.expected_cost_ex, r.expected_commission_ex;
  END IF;
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'TP13-12';
  IF r.committed_open_ex <> 100 OR r.actual_cost_ex <> 1100 OR r.profit_ex_unsuppressed <> 900 THEN
    RAISE EXCEPTION 'tp13 shape: TP13-12 committed % actual % unsuppressed %', r.committed_open_ex, r.actual_cost_ex, r.profit_ex_unsuppressed;
  END IF;
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'TP13-11';
  IF r.actual_cost_ex <> 800 OR r.expected_cost_ex <> 1200 OR r.profit_ex_unsuppressed <> 1200 THEN
    RAISE EXCEPTION 'tp13 shape: TP13-11 actual % expected % unsuppressed %', r.actual_cost_ex, r.expected_cost_ex, r.profit_ex_unsuppressed;
  END IF;
END $$;

-- ── Readers: job_profit(uuid) and the story money book ────────────────────
DO $$
DECLARE r record; b jsonb;
BEGIN
  SELECT * INTO r FROM public.job_profit('d1300000-0000-4000-8000-000000000011');
  IF r.cost_flag IS DISTINCT FROM 'materials_below_quote' OR r.profit_ex IS NOT NULL THEN
    RAISE EXCEPTION 'tp13 reader: job_profit(uuid) % %', r.cost_flag, r.profit_ex;
  END IF;
  b := public.context_job_story_book('d1300000-0000-4000-8000-000000000011');
  IF b ->> 'complete' <> 'false' OR b ->> 'reason' <> 'materials_below_quote'
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(b -> 'lines') l WHERE l LIKE 'Margin: Unknown%') THEN
    RAISE EXCEPTION 'tp13 reader: story book % %', b ->> 'reason', b -> 'lines';
  END IF;
  b := public.context_job_story_book('d1300000-0000-4000-8000-000000000019');
  IF b ->> 'complete' <> 'false'
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(b -> 'lines') l WHERE l LIKE 'Margin: Unknown%') THEN
    RAISE EXCEPTION 'tp13 reader: story book shows a margin for an uninvoiced variation: %', b -> 'lines';
  END IF;
  b := public.context_job_story_book('d1300000-0000-4000-8000-000000000001');
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(b -> 'lines') l WHERE l LIKE 'Margin: $900.00 ex GST profit%') THEN
    RAISE EXCEPTION 'tp13 reader: story book lost the complete job''s margin: %', b -> 'lines';
  END IF;
END $$;

ROLLBACK;
