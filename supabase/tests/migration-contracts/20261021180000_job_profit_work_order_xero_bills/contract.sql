-- Contract for 20261021180000_job_profit_work_order_xero_bills.
--
-- Synthetic jobs, fixed dates, no customer data. The three switches are
-- seeded off. This transaction turns them on, proves the new behaviour, and
-- rolls back, so a committed database stays off.
--
--   JP2-WO     draft job work order agreed 250.50; a draft variation of 999
--              is not added. Flag off: expected labour stays the quote's 100.
--              Flag on: expected labour is 250.50.
--   JP2-WO0    agreed labour 0 is a real figure, not "no work order".
--   JP2-XERO   project expenses 5000 above a 300 labour bill and a 10000
--              invoice. Flag off: margin null. Flag on: margin uses 5000 and
--              is marked from Xero Project. actual cost stays 300.
--   JP2-XERO0  project above the lines, nothing invoiced: margin stays null.
--              The project name must not also match JP2-XERO.
--   JP2-PATIO  newest frozen patio quote 8500, no sent quote.
--   JP2-PQUOT  still quoted: the frozen quote is not the sales price.
--   JP2-PLIVE  live pricing only: flagged, not published.
--   JP2-PCONF  frozen ex and inc disagree: flagged, and the live price is
--              not also called live-only.
--   JP2-PDIFF  sent quote and frozen quote differ by more than $1: published
--              price is null.
--   JP2-PNEAR  they agree within $1: the frozen figure is published.
--   JP2-PBAD   frozen quote cannot be read: the sent quote is kept, and the
--              row is flagged.
--   JP2-R1     a named scope revision that is missing is not replaced by a
--              later frozen revision.
--   JP2-R2     accepted_at uses the revision frozen at or before that time.
--   JP2-R2X    accepted_at with only a later revision does not fall through.

\set ON_ERROR_STOP on

DO $$
DECLARE
  name text;
  n int;
BEGIN
  FOREACH name IN ARRAY ARRAY[
    'job_profit_work_order_labour_v1',
    'job_profit_xero_project_cost_v1',
    'job_profit_patio_quote_v1'
  ] LOOP
    SELECT count(*) INTO n FROM public.feature_flags WHERE flag_name = name;
    IF n <> 1 THEN
      RAISE EXCEPTION '% must exist exactly once (found %)', name, n;
    END IF;
    IF (SELECT enabled FROM public.feature_flags WHERE flag_name = name) IS DISTINCT FROM false THEN
      RAISE EXCEPTION '% must be seeded off', name;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY[
      'margin_source', 'margin_cost_ex', 'expected_labour_quote_ex', 'work_order_agreed_labour_ex'
    ]) AS c(name)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'v_job_profit' AND column_name = c.name
    )
  ) THEN
    RAISE EXCEPTION 'v_job_profit is missing one of the four new columns';
  END IF;
END $$;

-- A re-apply never adds a second row and never switches off a flag the owner turned on.
BEGIN;
UPDATE public.feature_flags SET enabled = true
WHERE flag_name IN (
  'job_profit_work_order_labour_v1',
  'job_profit_xero_project_cost_v1',
  'job_profit_patio_quote_v1'
);
INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT 'job_profit_work_order_labour_v1', false, 're-apply'
WHERE NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'job_profit_work_order_labour_v1');
INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT 'job_profit_xero_project_cost_v1', false, 're-apply'
WHERE NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'job_profit_xero_project_cost_v1');
INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT 'job_profit_patio_quote_v1', false, 're-apply'
WHERE NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'job_profit_patio_quote_v1');
DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY[
    'job_profit_work_order_labour_v1',
    'job_profit_xero_project_cost_v1',
    'job_profit_patio_quote_v1'
  ] LOOP
    IF (SELECT count(*) FROM public.feature_flags WHERE flag_name = name) <> 1 THEN
      RAISE EXCEPTION 're-apply added a second % row', name;
    END IF;
    IF (SELECT enabled FROM public.feature_flags WHERE flag_name = name) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 're-apply switched % off', name;
    END IF;
  END LOOP;
END $$;
ROLLBACK;

BEGIN;

INSERT INTO public.jobs (
  id, org_id, status, type, job_number, legacy, metadata, pricing_json, expected_costs, accepted_at, created_at
) VALUES
  ('a7600000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'JP2-WO', false, '{}', '{}',
   '{"lanes": {"labour": {"amount_ex_gst": 100}, "materials": {"amount_ex_gst": 40}, "commission": {"amount_ex_gst": 10}}}',
   NULL, '2026-08-01T00:00:00Z'),
  ('a7600000-0000-4000-8000-00000000000e', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'JP2-WO0', false, '{}', '{}',
   '{"lanes": {"labour": {"amount_ex_gst": 100}, "materials": {"amount_ex_gst": 40}, "commission": {"amount_ex_gst": 10}}}',
   NULL, '2026-08-01T00:00:00Z'),
  ('a7600000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'JP2-XERO', false, '{}', '{}',
   NULL, NULL, '2026-08-01T00:00:00Z'),
  ('a7600000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'JP2-XERO0', false, '{}', '{}',
   NULL, NULL, '2026-08-01T00:00:00Z'),
  ('a7600000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000001', 'complete', 'patio', 'JP2-PATIO', false, '{}', '{}',
   NULL, NULL, '2026-08-01T00:00:00Z'),
  ('a7600000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000001', 'quoted', 'patio', 'JP2-PQUOT', false, '{}', '{}',
   NULL, NULL, '2026-08-01T00:00:00Z'),
  ('a7600000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000001', 'complete', 'patio', 'JP2-PLIVE', false, '{}',
   '{"totalExGST": 4200, "totalIncGST": 4620}', NULL, NULL, '2026-08-01T00:00:00Z'),
  ('a7600000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000001', 'complete', 'patio', 'JP2-PCONF', false, '{}',
   '{"totalExGST": 9000, "totalIncGST": 9900}', NULL, NULL, '2026-08-01T00:00:00Z'),
  ('a7600000-0000-4000-8000-000000000008', '00000000-0000-0000-0000-000000000001', 'complete', 'patio', 'JP2-PDIFF', false, '{}', '{}',
   NULL, NULL, '2026-08-01T00:00:00Z'),
  ('a7600000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000001', 'complete', 'patio', 'JP2-PNEAR', false, '{}', '{}',
   NULL, NULL, '2026-08-01T00:00:00Z'),
  ('a7600000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000001', 'complete', 'patio', 'JP2-PBAD', false, '{}', '{}',
   NULL, NULL, '2026-08-01T00:00:00Z'),
  ('a7600000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000001', 'complete', 'patio', 'JP2-R1', false, '{}', '{}',
   '{"scope_revision_id": "a7640000-0000-4000-8000-000000000099"}', NULL, '2026-08-01T00:00:00Z'),
  ('a7600000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000001', 'complete', 'patio', 'JP2-R2', false, '{}', '{}',
   NULL, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'),
  ('a7600000-0000-4000-8000-00000000000d', '00000000-0000-0000-0000-000000000001', 'complete', 'patio', 'JP2-R2X', false, '{}', '{}',
   NULL, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');

INSERT INTO public.work_orders (org_id, job_id, wo_number, kind, status, origin, agreed_labour_ex) VALUES
  ('00000000-0000-0000-0000-000000000001', 'a7600000-0000-4000-8000-000000000001', 'JP2-WO-1', 'job', 'draft', 'manual', 250.50),
  ('00000000-0000-0000-0000-000000000001', 'a7600000-0000-4000-8000-00000000000e', 'JP2-WO0-1', 'job', 'draft', 'manual', 0);

INSERT INTO public.work_order_customer_variations (org_id, job_id, description, trade_allocation_ex, created_by) VALUES
  ('00000000-0000-0000-0000-000000000001', 'a7600000-0000-4000-8000-000000000001', 'Draft variation that must not count', 999, 'contract');

INSERT INTO public.xero_invoices (
  org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name,
  sub_total, total, amount_paid, invoice_date, job_id, raw_json, line_items
) VALUES
  ('00000000-0000-0000-0000-000000000001', 'BILL-JP2-XERO', 'BILL-JP2-XERO', 'ACCPAY', 'PAID', 'Supplies',
   300, 300, 300, '2026-08-02', 'a7600000-0000-4000-8000-000000000002', '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 300, "AccountCode": "306", "Description": "Install hand"}]'),
  ('00000000-0000-0000-0000-000000000001', 'INV-JP2-XERO', 'INV-JP2-XERO', 'ACCREC', 'AUTHORISED', 'Client',
   10000, 11000, 0, '2026-08-08', 'a7600000-0000-4000-8000-000000000002', '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 10000, "AccountCode": "200", "Description": "Fence"}]'),
  ('00000000-0000-0000-0000-000000000001', 'BILL-JP2-XERO0', 'BILL-JP2-XERO0', 'ACCPAY', 'AUTHORISED', 'Supplies',
   100, 100, 0, '2026-08-02', 'a7600000-0000-4000-8000-000000000003', '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 100, "AccountCode": "306", "Description": "Install hand"}]');

INSERT INTO public.xero_projects (job_id, project_name, total_expenses, total_invoiced) VALUES
  ('a7600000-0000-4000-8000-000000000002', 'JP2-XERO 1 Site', 5000, 10000),
  ('a7600000-0000-4000-8000-000000000003', 'JP2-XERO0 2 Site', 2000, 0);

INSERT INTO public.scope_revisions (
  id, job_id, revision_number, tool_kind, scope_canonical_text, scope_hash,
  pricing_canonical_text, pricing_hash, renderer_version, tool_version, status, frozen_at
) VALUES
  ('a7640000-0000-4000-8000-000000000001', 'a7600000-0000-4000-8000-000000000004', 1, 'patio', '{}', repeat('a', 64),
   '{"totalExGST": 8500}', repeat('b', 64), 'contract', 'contract', 'frozen', '2026-07-01T00:00:00Z'),
  ('a7640000-0000-4000-8000-000000000002', 'a7600000-0000-4000-8000-000000000005', 1, 'patio', '{}', repeat('a', 64),
   '{"totalExGST": 8500}', repeat('b', 64), 'contract', 'contract', 'frozen', '2026-07-01T00:00:00Z'),
  ('a7640000-0000-4000-8000-000000000003', 'a7600000-0000-4000-8000-000000000007', 1, 'patio', '{}', repeat('a', 64),
   '{"totalExGST": 100, "totalIncGST": 200}', repeat('b', 64), 'contract', 'contract', 'frozen', '2026-07-01T00:00:00Z'),
  ('a7640000-0000-4000-8000-000000000004', 'a7600000-0000-4000-8000-000000000008', 1, 'patio', '{}', repeat('a', 64),
   '{"totalExGST": 8500}', repeat('b', 64), 'contract', 'contract', 'frozen', '2026-07-01T00:00:00Z'),
  ('a7640000-0000-4000-8000-000000000005', 'a7600000-0000-4000-8000-000000000009', 1, 'patio', '{}', repeat('a', 64),
   '{"totalExGST": 1500.40}', repeat('b', 64), 'contract', 'contract', 'frozen', '2026-07-01T00:00:00Z'),
  ('a7640000-0000-4000-8000-000000000006', 'a7600000-0000-4000-8000-00000000000a', 1, 'patio', '{}', repeat('a', 64),
   'not-json', repeat('b', 64), 'contract', 'contract', 'frozen', '2026-07-01T00:00:00Z'),
  ('a7640000-0000-4000-8000-000000000007', 'a7600000-0000-4000-8000-00000000000b', 1, 'patio', '{}', repeat('a', 64),
   '{"totalExGST": 8500}', repeat('b', 64), 'contract', 'contract', 'frozen', '2026-07-01T00:00:00Z'),
  ('a7640000-0000-4000-8000-000000000008', 'a7600000-0000-4000-8000-00000000000c', 1, 'patio', '{}', repeat('a', 64),
   '{"totalExGST": 4200}', repeat('b', 64), 'contract', 'contract', 'frozen', '2026-07-01T00:00:00Z'),
  ('a7640000-0000-4000-8000-000000000009', 'a7600000-0000-4000-8000-00000000000c', 2, 'patio', '{}', repeat('a', 64),
   '{"totalExGST": 9999}', repeat('c', 64), 'contract', 'contract', 'frozen', '2026-09-01T00:00:00Z'),
  ('a7640000-0000-4000-8000-00000000000a', 'a7600000-0000-4000-8000-00000000000d', 1, 'patio', '{}', repeat('a', 64),
   '{"totalExGST": 7777}', repeat('b', 64), 'contract', 'contract', 'frozen', '2026-09-01T00:00:00Z');

INSERT INTO public.job_documents (id, job_id, type, sent_at, created_at) VALUES
  ('a7630000-0000-4000-8000-000000000001', 'a7600000-0000-4000-8000-000000000008', 'quote', '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z'),
  ('a7630000-0000-4000-8000-000000000002', 'a7600000-0000-4000-8000-000000000009', 'quote', '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z'),
  ('a7630000-0000-4000-8000-000000000003', 'a7600000-0000-4000-8000-00000000000a', 'quote', '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z');

INSERT INTO public.quote_revisions (
  job_id, job_document_id, version, recipient_email, scope_snapshot_json, pricing_snapshot_json,
  totals_snapshot_json, manifest_url, manifest_hash, pdf_url, released_via, build_kind, sent_at,
  internal_cost_snapshot_json
) VALUES
  ('a7600000-0000-4000-8000-000000000008', 'a7630000-0000-4000-8000-000000000001', 1, 'client@example.com', '{}', '{}',
   '{"total_inc_gst": 1650}', 'https://example.invalid/m', repeat('d', 64), 'https://example.invalid/p',
   'send-quote/send', 'patio', '2026-07-20T00:00:00Z', '{}'),
  ('a7600000-0000-4000-8000-000000000009', 'a7630000-0000-4000-8000-000000000002', 1, 'client@example.com', '{}', '{}',
   '{"total_inc_gst": 1650}', 'https://example.invalid/m', repeat('d', 64), 'https://example.invalid/p',
   'send-quote/send', 'patio', '2026-07-20T00:00:00Z', '{}'),
  ('a7600000-0000-4000-8000-00000000000a', 'a7630000-0000-4000-8000-000000000003', 1, 'client@example.com', '{}', '{}',
   '{"total_inc_gst": 1650}', 'https://example.invalid/m', repeat('d', 64), 'https://example.invalid/p',
   'send-quote/send', 'patio', '2026-07-20T00:00:00Z', '{}');

CREATE FUNCTION pg_temp.num(p_label text, p_got numeric, p_want numeric) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION '%: got % want %', p_label, p_got, p_want;
  END IF;
END $$;

CREATE FUNCTION pg_temp.txt(p_label text, p_got text, p_want text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION '%: got [%] want [%]', p_label, p_got, p_want;
  END IF;
END $$;

CREATE FUNCTION pg_temp.has_item(p_label text, p_arr text[], p_item text, p_want boolean) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_has boolean;
BEGIN
  v_has := p_item = ANY (COALESCE(p_arr, ARRAY[]::text[]));
  IF v_has IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION '%: % in % wanted %', p_label, p_item, p_arr, p_want;
  END IF;
END $$;

-- Flags off: existing columns stay on the quote / line-level rules.
DO $$
DECLARE
  r public.v_job_profit;
  one public.v_job_profit;
BEGIN
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP2-WO';
  PERFORM pg_temp.num('WO off labour', r.expected_labour_ex, 100);
  PERFORM pg_temp.txt('WO off source', r.expected_source, 'frozen_at_acceptance');
  PERFORM pg_temp.num('WO off quote labour', r.expected_labour_quote_ex, 100);
  PERFORM pg_temp.num('WO off agreed', r.work_order_agreed_labour_ex, 250.50);
  PERFORM pg_temp.num('WO off expected', r.expected_cost_ex, 150);
  PERFORM pg_temp.txt('WO off margin source', r.margin_source, NULL);

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP2-WO0';
  PERFORM pg_temp.num('WO0 off labour', r.expected_labour_ex, 100);
  PERFORM pg_temp.num('WO0 off agreed', r.work_order_agreed_labour_ex, 0);
  PERFORM pg_temp.num('WO0 off expected', r.expected_cost_ex, 150);

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP2-XERO';
  PERFORM pg_temp.num('XERO off profit', r.profit_ex, NULL);
  PERFORM pg_temp.num('XERO off margin', r.margin_pct, NULL);
  PERFORM pg_temp.txt('XERO off flag', r.cost_flag, 'xero_project_exceeds_line_costs');
  PERFORM pg_temp.num('XERO off actual', r.actual_cost_ex, 300);
  PERFORM pg_temp.txt('XERO off basis', r.cost_basis, 'line_level');
  PERFORM pg_temp.txt('XERO off margin source', r.margin_source, NULL);
  PERFORM pg_temp.num('XERO off margin cost', r.margin_cost_ex, NULL);
  PERFORM pg_temp.num('XERO off unsuppressed', r.profit_ex_unsuppressed, NULL);
  PERFORM pg_temp.has_item('XERO off note', r.completeness, 'margin_from_xero_project', false);
  PERFORM pg_temp.has_item('XERO off exceeds', r.completeness, 'xero_project_exceeds_line_costs', true);

  SELECT * INTO one FROM public.job_profit('a7600000-0000-4000-8000-000000000002');
  IF one.profit_ex IS DISTINCT FROM r.profit_ex OR one.actual_cost_ex IS DISTINCT FROM r.actual_cost_ex THEN
    RAISE EXCEPTION 'job_profit(uuid) disagreed with the view while flags are off';
  END IF;

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP2-XERO0';
  PERFORM pg_temp.num('XERO0 off profit', r.profit_ex, NULL);
  PERFORM pg_temp.txt('XERO0 off flag', r.cost_flag, 'xero_project_exceeds_line_costs');
  PERFORM pg_temp.num('XERO0 off project', r.xero_project_expenses_ex, 2000);

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP2-PATIO';
  PERFORM pg_temp.num('PATIO off quoted', r.quoted_ex, NULL);
  PERFORM pg_temp.has_item('PATIO off live', r.completeness, 'patio_sales_price_live_only', false);
  PERFORM pg_temp.has_item('PATIO off conflict', r.completeness, 'patio_sales_price_conflict', false);
  PERFORM pg_temp.has_item('PATIO off unread', r.completeness, 'patio_sales_price_unreadable', false);

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP2-PLIVE';
  PERFORM pg_temp.num('PLIVE off quoted', r.quoted_ex, NULL);
  PERFORM pg_temp.has_item('PLIVE off live', r.completeness, 'patio_sales_price_live_only', false);

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP2-PDIFF';
  PERFORM pg_temp.num('PDIFF off quoted', r.quoted_ex, 1500);
  PERFORM pg_temp.has_item('PDIFF off conflict', r.completeness, 'patio_sales_price_conflict', false);

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP2-PBAD';
  PERFORM pg_temp.num('PBAD off quoted', r.quoted_ex, 1500);
  PERFORM pg_temp.has_item('PBAD off unread', r.completeness, 'patio_sales_price_unreadable', false);
END $$;

UPDATE public.feature_flags SET enabled = true
WHERE flag_name IN (
  'job_profit_work_order_labour_v1',
  'job_profit_xero_project_cost_v1',
  'job_profit_patio_quote_v1'
);

DO $$
DECLARE
  r public.v_job_profit;
BEGIN
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP2-WO';
  PERFORM pg_temp.num('WO on labour', r.expected_labour_ex, 250.50);
  PERFORM pg_temp.txt('WO on source', r.expected_source, 'job_work_order');
  PERFORM pg_temp.num('WO on quote labour', r.expected_labour_quote_ex, 100);
  PERFORM pg_temp.num('WO on agreed', r.work_order_agreed_labour_ex, 250.50);
  PERFORM pg_temp.num('WO on expected', r.expected_cost_ex, 300.50);

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP2-WO0';
  PERFORM pg_temp.num('WO0 on labour', r.expected_labour_ex, 0);
  PERFORM pg_temp.txt('WO0 on source', r.expected_source, 'job_work_order');
  PERFORM pg_temp.num('WO0 on quote labour', r.expected_labour_quote_ex, 100);
  PERFORM pg_temp.num('WO0 on expected', r.expected_cost_ex, 50);

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP2-XERO';
  PERFORM pg_temp.num('XERO on profit', r.profit_ex, 5000);
  PERFORM pg_temp.num('XERO on margin', r.margin_pct, 50);
  PERFORM pg_temp.txt('XERO on source', r.margin_source, 'from Xero Project');
  PERFORM pg_temp.num('XERO on margin cost', r.margin_cost_ex, 5000);
  PERFORM pg_temp.num('XERO on actual', r.actual_cost_ex, 300);
  PERFORM pg_temp.txt('XERO on basis', r.cost_basis, 'line_level');
  PERFORM pg_temp.txt('XERO on flag', r.cost_flag, 'ok');
  PERFORM pg_temp.num('XERO on unsuppressed', r.profit_ex_unsuppressed, NULL);
  PERFORM pg_temp.has_item('XERO on exceeds', r.completeness, 'xero_project_exceeds_line_costs', true);
  PERFORM pg_temp.has_item('XERO on materials', r.completeness, 'materials_not_linked', true);
  PERFORM pg_temp.has_item('XERO on from project', r.completeness, 'margin_from_xero_project', true);
  PERFORM pg_temp.has_item('XERO on no labour', r.completeness, 'no_labour_linked', false);

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP2-XERO0';
  PERFORM pg_temp.num('XERO0 on profit', r.profit_ex, NULL);
  PERFORM pg_temp.txt('XERO0 on flag', r.cost_flag, 'ok');
  PERFORM pg_temp.txt('XERO0 on revenue', r.revenue_flag, 'missing_client_invoice');
  PERFORM pg_temp.num('XERO0 on project', r.xero_project_expenses_ex, 2000);
  PERFORM pg_temp.has_item('XERO0 on from project', r.completeness, 'margin_from_xero_project', false);
  PERFORM pg_temp.txt('XERO0 on margin source', r.margin_source, NULL);

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP2-PATIO';
  PERFORM pg_temp.num('PATIO on quoted', r.quoted_ex, 8500);
  PERFORM pg_temp.txt('PATIO on source', r.quoted_source, 'patio_quote:latest_frozen_revision');
  PERFORM pg_temp.num('PATIO on expected', r.expected_cost_ex, NULL);

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP2-PQUOT';
  PERFORM pg_temp.num('PQUOT on quoted', r.quoted_ex, NULL);
  PERFORM pg_temp.has_item('PQUOT on live', r.completeness, 'patio_sales_price_live_only', false);

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP2-PLIVE';
  PERFORM pg_temp.num('PLIVE on quoted', r.quoted_ex, NULL);
  PERFORM pg_temp.has_item('PLIVE on live', r.completeness, 'patio_sales_price_live_only', true);

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP2-PCONF';
  PERFORM pg_temp.num('PCONF on quoted', r.quoted_ex, NULL);
  PERFORM pg_temp.has_item('PCONF on conflict', r.completeness, 'patio_sales_price_conflict', true);
  PERFORM pg_temp.has_item('PCONF on live', r.completeness, 'patio_sales_price_live_only', false);

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP2-PDIFF';
  PERFORM pg_temp.num('PDIFF on quoted', r.quoted_ex, NULL);
  PERFORM pg_temp.txt('PDIFF on source', r.quoted_source, NULL);
  PERFORM pg_temp.has_item('PDIFF on conflict', r.completeness, 'patio_sales_price_conflict', true);

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP2-PNEAR';
  PERFORM pg_temp.num('PNEAR on quoted', r.quoted_ex, 1500.40);
  PERFORM pg_temp.txt('PNEAR on source', r.quoted_source, 'patio_quote:latest_frozen_revision');
  PERFORM pg_temp.has_item('PNEAR on conflict', r.completeness, 'patio_sales_price_conflict', false);

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP2-PBAD';
  PERFORM pg_temp.num('PBAD on quoted', r.quoted_ex, 1500);
  PERFORM pg_temp.has_item('PBAD on unread', r.completeness, 'patio_sales_price_unreadable', true);
  IF r.quoted_source NOT LIKE 'sent_quote:%' THEN
    RAISE EXCEPTION 'PBAD on source: got [%]', r.quoted_source;
  END IF;

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP2-R1';
  PERFORM pg_temp.num('R1 on quoted', r.quoted_ex, NULL);
  PERFORM pg_temp.num('R1 on labour', r.expected_labour_ex, NULL);

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP2-R2';
  PERFORM pg_temp.num('R2 on quoted', r.quoted_ex, 4200);
  PERFORM pg_temp.txt('R2 on source', r.quoted_source, 'patio_quote:revision_at_acceptance');

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP2-R2X';
  PERFORM pg_temp.num('R2X on quoted', r.quoted_ex, NULL);
  PERFORM pg_temp.txt('R2X on source', r.quoted_source, NULL);
END $$;

ROLLBACK;
