-- Synthetic H7 fixtures (no customer data), shared by the
-- 20261029170000_cfo_bill_cost_outcomes and 20261029170100_context_job_bill_outcomes
-- contracts. The caller opens the transaction and rolls it back.
--
-- Jobs: H7-J1, H7-J2, H7-J3, H7-J4 (finished fencing), H7-LEG (legacy),
-- H7-HOLD (holding job).
-- Bills (ordinary materials bill, account 310, unless named; ex GST):
--   H7-PLAIN    1000, Xero job J1, no rows
--   H7-SAME     500, Xero job J1, a person's whole row on J1
--   H7-MOVE     400, Xero job J1, a person's whole row on J2
--   H7-SPLIT    1000, a person's split: 600 J1 + 400 J2
--   H7-SPLITOH  1000, a person's split: 600 J1 + overhead 400
--   H7-UNBAL    1000, a split row 600 on J1 only, nothing else
--   H7-OH       1000, Xero job J1, overhead equal to the bill, no rows
--   H7-OH2      1000, Xero job J1, overhead 300, no rows
--   H7-NJR      400, Xero job J1, marked not job related by a person, no rows (F1)
--   H7-INST     1000 installer (306), Xero job J1, no rows
--   H7-INSTAI   600 installer (301), the AI bill reader's row on J1
--   H7-INSTNJR  500 installer (306), Xero job J1, marked not job related
--   H7-LAB      400, a rule's labour row (xero_ref_link) on J2
--   H7-UNREC    300, a manual_queue row on J2 by ops_dashboard
--   H7-VOID     700 VOIDED, Xero job J1, a person's row on J2
--   H7-DRAFT    200 DRAFT, Xero job J1, no rows
--   H7-XL       400, Xero job J1, an expected-kind row on J2
--   H7-LEGB     250, a person's row on H7-LEG (legacy)
--   H7-MISS     150, a person's row on J1, no stored copy of the bill
--   H7-NULLAMT  a person's row on J2 with no amount, bill 90
--   H7-MIR      300 trade-app mirror (| SW - FENCING), Xero job J1
--   H7-CRED     1000 PAID, Xero job J1, AmountCredited 110 of 1100
--   H7-HOLDB    120, a person's row on H7-HOLD
--   H7-OVER1    1000, a person's whole row of 1200 on J3 (over-counted)
--   H7-OVER2    1000, a person's split: 700 J3 + 700 J4 (over-counted)
--   H7-OVER3    1000, a person's split: 700 J3 + overhead 400 (over-counted)
--   H7-MIRP     200 trade-app mirror (| SW - FENCING), a person's row on J3

INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, pricing_json, expected_costs, created_at) VALUES
  ('c7000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'H7-J1', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z'),
  ('c7000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'H7-J2', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z'),
  ('c7000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'H7-LEG', true, '{}', '{}', NULL, '2026-07-01T00:00:00Z'),
  ('c7000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'H7-HOLD', false, '{"do_not_schedule": "true"}', '{}', NULL, '2026-07-01T00:00:00Z'),
  ('c7000000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'H7-J3', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z'),
  ('c7000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'H7-J4', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z');

INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, line_items, raw_json, job_id)
SELECT '00000000-0000-0000-0000-000000000001', b.id, 'B-' || b.id, 'ACCPAY', b.status, 'H7 Supplier', b.ex, b.ex * 1.1, '2026-08-27',
       jsonb_build_array(jsonb_build_object('Description', b.descr, 'AccountCode', b.acct, 'LineAmount', b.ex, 'TaxAmount', b.ex * 0.1)),
       b.raw, b.job
FROM (VALUES
  ('H7-PLAIN',   1000, '310', 'AUTHORISED', 'Supply', '{"LineAmountTypes": "Exclusive"}'::jsonb, 'c7000000-0000-4000-8000-000000000001'::uuid),
  ('H7-SAME',     500, '310', 'AUTHORISED', 'Supply', '{"LineAmountTypes": "Exclusive"}', 'c7000000-0000-4000-8000-000000000001'),
  ('H7-MOVE',     400, '310', 'AUTHORISED', 'Supply', '{"LineAmountTypes": "Exclusive"}', 'c7000000-0000-4000-8000-000000000001'),
  ('H7-SPLIT',   1000, '310', 'AUTHORISED', 'Supply', '{"LineAmountTypes": "Exclusive"}', NULL),
  ('H7-SPLITOH', 1000, '310', 'AUTHORISED', 'Supply', '{"LineAmountTypes": "Exclusive"}', NULL),
  ('H7-UNBAL',   1000, '310', 'AUTHORISED', 'Supply', '{"LineAmountTypes": "Exclusive"}', NULL),
  ('H7-OH',      1000, '310', 'AUTHORISED', 'Supply', '{"LineAmountTypes": "Exclusive"}', 'c7000000-0000-4000-8000-000000000001'),
  ('H7-OH2',     1000, '310', 'AUTHORISED', 'Supply', '{"LineAmountTypes": "Exclusive"}', 'c7000000-0000-4000-8000-000000000001'),
  ('H7-NJR',      400, '310', 'AUTHORISED', 'Supply', '{"LineAmountTypes": "Exclusive"}', 'c7000000-0000-4000-8000-000000000001'),
  ('H7-INST',    1000, '306', 'AUTHORISED', 'Install', '{"LineAmountTypes": "Exclusive"}', 'c7000000-0000-4000-8000-000000000001'),
  ('H7-INSTAI',   600, '301', 'AUTHORISED', 'Install', '{"LineAmountTypes": "Exclusive"}', NULL),
  ('H7-INSTNJR',  500, '306', 'AUTHORISED', 'Install', '{"LineAmountTypes": "Exclusive"}', 'c7000000-0000-4000-8000-000000000001'),
  ('H7-LAB',      400, '310', 'AUTHORISED', 'Supply', '{"LineAmountTypes": "Exclusive"}', NULL),
  ('H7-UNREC',    300, '310', 'AUTHORISED', 'Supply', '{"LineAmountTypes": "Exclusive"}', NULL),
  ('H7-VOID',     700, '310', 'VOIDED',     'Supply', '{"LineAmountTypes": "Exclusive"}', 'c7000000-0000-4000-8000-000000000001'),
  ('H7-DRAFT',    200, '310', 'DRAFT',      'Supply', '{"LineAmountTypes": "Exclusive"}', 'c7000000-0000-4000-8000-000000000001'),
  ('H7-XL',       400, '310', 'AUTHORISED', 'Supply', '{"LineAmountTypes": "Exclusive"}', 'c7000000-0000-4000-8000-000000000001'),
  ('H7-LEGB',     250, '310', 'AUTHORISED', 'Supply', '{"LineAmountTypes": "Exclusive"}', NULL),
  ('H7-NULLAMT',   90, '310', 'AUTHORISED', 'Supply', '{"LineAmountTypes": "Exclusive"}', NULL),
  ('H7-MIR',      300, '306', 'PAID',       'Week | SW - FENCING', '{"LineAmountTypes": "Exclusive"}', 'c7000000-0000-4000-8000-000000000001'),
  ('H7-CRED',    1000, '310', 'PAID',       'Supply', '{"LineAmountTypes": "Exclusive", "AmountCredited": 110}', 'c7000000-0000-4000-8000-000000000001'),
  ('H7-HOLDB',    120, '310', 'AUTHORISED', 'Supply', '{"LineAmountTypes": "Exclusive"}', NULL),
  ('H7-OVER1',   1000, '310', 'AUTHORISED', 'Supply', '{"LineAmountTypes": "Exclusive"}', NULL),
  ('H7-OVER2',   1000, '310', 'AUTHORISED', 'Supply', '{"LineAmountTypes": "Exclusive"}', NULL),
  ('H7-OVER3',   1000, '310', 'AUTHORISED', 'Supply', '{"LineAmountTypes": "Exclusive"}', NULL),
  ('H7-MIRP',     200, '306', 'AUTHORISED', 'Week | SW - FENCING', '{"LineAmountTypes": "Exclusive"}', NULL)
) AS b(id, ex, acct, status, descr, raw, job);

INSERT INTO public.materials_reconciliation_queue (xero_invoice_id, invoice_number, contact_name, sub_total, total, invoice_date, status, assigned_by, assigned_at, overhead_ex) VALUES
  ('H7-SPLITOH', 'B-H7-SPLITOH', 'H7 Supplier', 1000, 1100, '2026-08-27', 'split', 'person@h7.test', '2026-09-01T00:00:00Z', 400),
  ('H7-OH',      'B-H7-OH',      'H7 Supplier', 1000, 1100, '2026-08-27', 'split', 'person@h7.test', '2026-09-01T00:00:00Z', 1000),
  ('H7-OH2',     'B-H7-OH2',     'H7 Supplier', 1000, 1100, '2026-08-27', 'split', 'person@h7.test', '2026-09-01T00:00:00Z', 300),
  ('H7-NJR',     'B-H7-NJR',     'H7 Supplier', 400, 440, '2026-08-27', 'not_job_related', 'person@h7.test', '2026-09-01T00:00:00Z', NULL),
  ('H7-INSTNJR', 'B-H7-INSTNJR', 'H7 Supplier', 500, 550, '2026-08-27', 'not_job_related', 'person@h7.test', '2026-09-01T00:00:00Z', NULL),
  ('H7-OVER3',   'B-H7-OVER3',   'H7 Supplier', 1000, 1100, '2026-08-27', 'split', 'person@h7.test', '2026-09-01T00:00:00Z', 400);

INSERT INTO public.job_materials_facts (xero_invoice_id, job_id, job_number, lane, kind, amount_ex_gst, confidence, automation_source, fact_date, assigned_by) VALUES
  ('H7-SAME',    'c7000000-0000-4000-8000-000000000001', 'H7-J1', 'materials', 'actual', 500, 'high_manual', 'manual_queue', '2026-08-27', 'person@h7.test'),
  ('H7-MOVE',    'c7000000-0000-4000-8000-000000000002', 'H7-J2', 'materials', 'actual', 400, 'high_manual', 'manual_queue', '2026-08-27', 'person@h7.test'),
  ('H7-SPLIT',   'c7000000-0000-4000-8000-000000000001', 'H7-J1', 'materials', 'actual', 600, 'high_manual', 'manual_split', '2026-08-27', 'person@h7.test'),
  ('H7-SPLIT',   'c7000000-0000-4000-8000-000000000002', 'H7-J2', 'materials', 'actual', 400, 'high_manual', 'manual_split', '2026-08-27', 'person@h7.test'),
  ('H7-SPLITOH', 'c7000000-0000-4000-8000-000000000001', 'H7-J1', 'materials', 'actual', 600, 'high_manual', 'manual_split', '2026-08-27', 'person@h7.test'),
  ('H7-UNBAL',   'c7000000-0000-4000-8000-000000000001', 'H7-J1', 'materials', 'actual', 600, 'high_manual', 'manual_split', '2026-08-27', 'person@h7.test'),
  ('H7-INSTAI',  'c7000000-0000-4000-8000-000000000001', 'H7-J1', 'labour', 'actual', 600, 'high', 'agent_ai', '2026-08-27', 'ai:test-model'),
  ('H7-LAB',     'c7000000-0000-4000-8000-000000000002', 'H7-J2', 'labour', 'actual', 400, 'high', 'xero_ref_link', '2026-08-27', NULL),
  ('H7-UNREC',   'c7000000-0000-4000-8000-000000000002', 'H7-J2', 'materials', 'actual', 300, 'high_manual', 'manual_queue', '2026-08-27', 'ops_dashboard'),
  ('H7-VOID',    'c7000000-0000-4000-8000-000000000002', 'H7-J2', 'materials', 'actual', 700, 'high_manual', 'manual_queue', '2026-08-27', 'person@h7.test'),
  ('H7-XL',      'c7000000-0000-4000-8000-000000000002', 'H7-J2', 'materials', 'expected', 400, 'high', 'xero_ref_link', '2026-08-27', NULL),
  ('H7-LEGB',    'c7000000-0000-4000-8000-000000000003', 'H7-LEG', 'materials', 'actual', 250, 'high_manual', 'manual_queue', '2026-08-27', 'person@h7.test'),
  ('H7-MISS',    'c7000000-0000-4000-8000-000000000001', 'H7-J1', 'materials', 'actual', 150, 'high_manual', 'manual_queue', '2026-08-27', 'person@h7.test'),
  ('H7-NULLAMT', 'c7000000-0000-4000-8000-000000000002', 'H7-J2', 'materials', 'actual', NULL, 'high_manual', 'manual_queue', '2026-08-27', 'person@h7.test'),
  ('H7-HOLDB',   'c7000000-0000-4000-8000-000000000004', 'H7-HOLD', 'materials', 'actual', 120, 'high_manual', 'manual_queue', '2026-08-27', 'person@h7.test'),
  ('H7-OVER1',   'c7000000-0000-4000-8000-000000000005', 'H7-J3', 'materials', 'actual', 1200, 'high_manual', 'manual_queue', '2026-08-27', 'person@h7.test'),
  ('H7-OVER2',   'c7000000-0000-4000-8000-000000000005', 'H7-J3', 'materials', 'actual', 700, 'high_manual', 'manual_split', '2026-08-27', 'person@h7.test'),
  ('H7-OVER2',   'c7000000-0000-4000-8000-000000000006', 'H7-J4', 'materials', 'actual', 700, 'high_manual', 'manual_split', '2026-08-27', 'person@h7.test'),
  ('H7-OVER3',   'c7000000-0000-4000-8000-000000000005', 'H7-J3', 'materials', 'actual', 700, 'high_manual', 'manual_split', '2026-08-27', 'person@h7.test'),
  ('H7-MIRP',    'c7000000-0000-4000-8000-000000000005', 'H7-J3', 'materials', 'actual', 200, 'high_manual', 'manual_queue', '2026-08-27', 'person@h7.test');
