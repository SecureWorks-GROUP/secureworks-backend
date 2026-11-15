-- Fixture bills for 20261116003000_sep_reconcile_placements. Included by contract.sql and
-- rollback-contract.sql inside their own transactions. Real ids from the approved list, so the
-- migration's own VALUES list finds them; every other listed bill is absent and must be skipped.
INSERT INTO public.jobs (id, org_id, status, type, job_number, metadata) VALUES
  ('a0000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'archived', 'fencing', 'SWF-261372', '{}'),
  ('a0000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'archived', 'patio', 'SWP-26183', '{}'),
  ('a0000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'archived', 'patio', 'SWP-26941', '{}'),
  ('a0000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000001', 'archived', 'fencing', 'SWF-261387', '{}'),
  ('a0000000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000001', 'scheduled', 'fencing', 'SWF-26101', '{}'),
  ('a0000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000001', 'archived', 'patio', 'SWP-261160', '{}'),
  ('a0000000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000001', 'archived', 'patio', 'SWP-261043', '{}'),
  ('a0000000-0000-4000-8000-000000000008', '00000000-0000-0000-0000-000000000001', 'cancelled', 'makesafe', 'SWMS-261441', '{}'),
  ('a0000000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000001', 'archived', 'patio', 'SWP-26090', '{}'),
  ('a0000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000001', 'archived', 'patio', 'SWP-26102', '{}'),
  ('a0000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000001', 'archived', 'patio', 'SWP-26320', '{"do_not_schedule": "true"}');

INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, sub_total, total, line_items) VALUES
  ('00000000-0000-0000-0000-000000000001', '48dd66ca-5e55-4d52-bcfc-1997413b26e3', 'INV 91584', 'ACCPAY', 'AUTHORISED', 72.27, 79.50, '[{"AccountCode":"305","LineAmount":72.27},{"Description":"text line"}]'),
  ('00000000-0000-0000-0000-000000000001', '7907cc63-3836-43d7-8322-468e3bc1f235', '202609', 'ACCPAY', 'PAID', 500, 500, '[{"AccountCode":"306","LineAmount":500}]'),
  ('00000000-0000-0000-0000-000000000001', 'fe33b791-556b-4ee0-8f8f-6c4f61dca31a', '2445/01224765', 'ACCPAY', 'PAID', 60, 66, '[{"AccountCode":"305","LineAmount":60}]'),
  ('00000000-0000-0000-0000-000000000001', 'a7a530a5-51bb-4ba9-9c8f-8844f3e3a6dd', '1977', 'ACCPAY', 'PAID', 327.27, 360, '[{"AccountCode":"305","LineAmount":327.27}]'),
  ('00000000-0000-0000-0000-000000000001', 'bf80a934-7587-4971-8d17-5d7c41a096a7', '2443/01442847', 'ACCPAY', 'PAID', 62.89, 69.18, '[{"AccountCode":"305","LineAmount":62.89}]'),
  ('00000000-0000-0000-0000-000000000001', 'ed6b5449-284b-47f6-915f-0f5584710ed3', 'INV10843', 'ACCPAY', 'PAID', 2379.71, 2617.68, '[{"AccountCode":"305","LineAmount":2379.71}]'),
  ('00000000-0000-0000-0000-000000000001', 'a0ef6c13-a1e9-4c74-85cd-216d994c36ae', '2435/01335472', 'ACCPAY', 'DRAFT', 40.97, 45.07, '[{"AccountCode":"305","LineAmount":40.97}]'),
  ('00000000-0000-0000-0000-000000000001', '08ca3a19-2a23-4735-bcf8-2f1aac08e517', 'W2SO0091876', 'ACCPAY', 'PAID', 543.10, 597.41, '[{"AccountCode":"305","LineAmount":543.10}]'),
  ('00000000-0000-0000-0000-000000000001', 'e4a5d66f-ce5f-4d80-970f-feb422f66119', '202608', 'ACCPAY', 'PAID', 576, 576, '[{"AccountCode":"306","LineAmount":409},{"AccountCode":"306","LineAmount":167}]'),
  ('00000000-0000-0000-0000-000000000001', '49a7466e-f1ec-41ef-acaa-0af6471694e3', '1046473', 'ACCPAY', 'PAID', 284.85, 313.34, '[{"AccountCode":"305","LineAmount":284.85}]');

INSERT INTO public.materials_reconciliation_queue (org_id, xero_invoice_id, invoice_number, contact_name, sub_total, total, invoice_date, status, created_at, updated_at) VALUES
  ('00000000-0000-0000-0000-000000000001', '48dd66ca-5e55-4d52-bcfc-1997413b26e3', 'INV 91584', 'R&R', 72.27, 79.50, '2026-11-09', 'open', '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', '7907cc63-3836-43d7-8322-468e3bc1f235', '202609', 'Crew', 500, 500, '2026-05-09', 'open', '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'fe33b791-556b-4ee0-8f8f-6c4f61dca31a', '2445/01224765', 'Bunnings', 60, 66, '2026-09-24', 'open', '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'a7a530a5-51bb-4ba9-9c8f-8844f3e3a6dd', '1977', 'Azzi', 327.27, 360, '2026-11-03', 'open', '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'bf80a934-7587-4971-8d17-5d7c41a096a7', '2443/01442847', 'Bunnings', 62.89, 69.18, '2026-10-19', 'assigned', '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'ed6b5449-284b-47f6-915f-0f5584710ed3', 'INV10843', 'Panel', 2379.71, 2617.68, '2026-09-29', 'open', '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'a0ef6c13-a1e9-4c74-85cd-216d994c36ae', '2435/01335472', 'Bunnings', 40.97, 45.07, '2026-10-01', 'open', '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', '08ca3a19-2a23-4735-bcf8-2f1aac08e517', 'W2SO0091876', 'Oxworks', 543.10, 597.41, '2026-10-02', 'open', '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'e4a5d66f-ce5f-4d80-970f-feb422f66119', '202608', 'Crew', 576, 576, '2026-04-24', 'open', '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', '49a7466e-f1ec-41ef-acaa-0af6471694e3', '1046473', 'Metroll', 284.85, 313.34, '2026-09-16', 'open', '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z');

-- 1977 already carries a fact (placed another way); INV10843 is a trade app mirror.
INSERT INTO public.job_materials_facts (org_id, xero_invoice_id, invoice_number, job_id, job_number, lane, kind, amount_ex_gst, confidence, automation_source, assigned_by)
VALUES ('00000000-0000-0000-0000-000000000001', 'a7a530a5-51bb-4ba9-9c8f-8844f3e3a6dd', '1977', 'a0000000-0000-4000-8000-000000000004', 'SWF-261387', 'materials', 'actual', 327.27, 'high', 'agent_ai', 'someone else');
INSERT INTO public.trade_invoices (id, org_id, status, xero_bill_id, subtotal_ex, gst_on, gst, total_inc, super_rate, super_amount, gross_earned, net_pay) VALUES
  ('b0000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'paid', 'ed6b5449-284b-47f6-915f-0f5584710ed3', 80, false, 0, 80, 0.12, 9.6, 80, 70.4);
