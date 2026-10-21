-- Contract for 20261021180000_job_profit_work_order_xero_bills.
--
-- Synthetic jobs, fixed dates, no customer data. The three switches are
-- seeded off. This transaction turns them on, proves the new behaviour, and
-- rolls back, so a committed database stays off.
--
-- Flags-off completeness is not identical to 20261020220000. JP-12's
-- installer blanking is always on: an unconfirmed installer bill flags
-- installer_bill_unconfirmed and blanks profit and margin whether or not a
-- switch is on. The three switches only gate work-order labour, the Xero
-- Project margin, and the patio quote.
--
--   SWF-261397  draft job work order agreed 250.50. Ignored. Expected labour
--               stays the quote's 160 with the labour switch on or off.
--   JP-WOOK     approved job work order 800 plus an approved variation of 50.
--               A draft variation of 999 is not added. Flag off: expected
--               labour stays 160, and the agreed figure is still shown.
--               Flag on: expected labour is 850, source job_work_order.
--   JP-WO0      approved agreed labour 0 is a real expected-labour figure.
--               It does not publish a Xero Project margin.
--   JP-XDONE    finished makesafe, agreed labour 0, person-confirmed labour
--               300. Project 5000, invoiced 10000. Flag off: margin null and
--               the suppressor stays. Flag on: the finished-status arm still
--               publishes, agreed 0 does not block it.
--   JP-XHOLD    in progress, person-confirmed labour 80 under agreed 8530.
--               Flag on: the project margin stays blank and the suppressor stays.
--   JP-XZERO    in progress, agreed labour 0, billed labour 0, project above
--               the lines. Flag on: 0 has reached 0, and the margin stays
--               blank because agreed labour is not above zero.
--   JP-IUN      unconfirmed installer bill beside confirmed materials.
--               Margin blank and cost_flag installer_bill_unconfirmed while
--               every switch is off. After a person places the bill, the
--               margin returns.
--   SWP-261247  frozen 5000 against live 9382: blank and flagged.
--   SWP-26100   frozen 1000 against live 2000: blank and flagged.
--   JP-POK      one frozen 5000, no live price, nothing invoiced past it:
--               published only while the patio switch is on.
--   Tokens      this migration does not write bill proposals and does not
--               install job_profit_bill_job_tokens. Supplier bills are linked
--               by job number through xero-sync bill prematch.
--               job_profit_link_bill is absent.

\set ON_ERROR_STOP on

DO $$
DECLARE
  name text;
  n int;
  tail text;
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

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'v_job_profit'
      AND column_name = 'quote_costs_incomplete'
  ) THEN
    RAISE EXCEPTION '1121 column quote_costs_incomplete is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'v_job_profit'
      AND column_name = 'invoice_emailed_ex'
  ) THEN
    RAISE EXCEPTION '1121 column invoice_emailed_ex is missing';
  END IF;

  SELECT string_agg(c.column_name, ',' ORDER BY c.ordinal_position) INTO tail
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'v_job_profit'
     AND c.ordinal_position > (
       SELECT ordinal_position FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'v_job_profit'
          AND column_name = 'quote_costs_incomplete'
     );
  IF tail IS DISTINCT FROM 'margin_source,margin_cost_ex,expected_labour_quote_ex,work_order_agreed_labour_ex' THEN
    RAISE EXCEPTION 'columns after quote_costs_incomplete are %, not the four appended columns', tail;
  END IF;

  IF to_regprocedure('public.job_profit_link_bill(text,text,text,text,text,text,text)') IS NOT NULL
     OR to_regprocedure('public.job_profit_bill_is_installer(jsonb)') IS NOT NULL
     OR to_regprocedure('public.job_profit_bill_job_tokens(text,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'job_profit_link_bill and job_profit_bill_job_tokens must not exist';
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

INSERT INTO public.users (id, org_id, name) VALUES
  ('a7611000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'Contract approver');

INSERT INTO public.jobs (
  id, org_id, status, type, job_number, legacy, metadata, pricing_json, expected_costs, created_at
) VALUES
  ('a7610000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'archived', 'fencing', 'SWF-261397', false, '{}', '{}',
   '{"lanes": {"labour": {"amount_ex_gst": 160}}}', '2026-08-01T00:00:00Z'),
  ('a7610000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'archived', 'fencing', 'JP-WOOK', false, '{}', '{}',
   '{"lanes": {"labour": {"amount_ex_gst": 160}, "materials": {"amount_ex_gst": 40}, "commission": {"amount_ex_gst": 10}}}',
   '2026-08-01T00:00:00Z'),
  ('a7610000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'archived', 'fencing', 'JP-WO0', false, '{}', '{}',
   '{"lanes": {"labour": {"amount_ex_gst": 100}}}', '2026-08-01T00:00:00Z'),
  ('a7610000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000001', 'complete', 'makesafe', 'JP-XDONE', false, '{}', '{}',
   NULL, '2026-08-01T00:00:00Z'),
  ('a7610000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000001', 'in_progress', 'makesafe', 'JP-XHOLD', false, '{}', '{}',
   NULL, '2026-08-01T00:00:00Z'),
  ('a7610000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000001', 'complete', 'patio', 'SWP-261247', false, '{}',
   '{"totalExGST": 9382, "totalIncGST": 10320.2}', NULL, '2026-08-01T00:00:00Z'),
  ('a7610000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000001', 'complete', 'patio', 'SWP-26100', false, '{}',
   '{"totalExGST": 2000, "totalIncGST": 2200}', NULL, '2026-08-01T00:00:00Z'),
  ('a7610000-0000-4000-8000-000000000008', '00000000-0000-0000-0000-000000000001', 'complete', 'patio', 'JP-POK', false, '{}',
   '{}', NULL, '2026-08-01T00:00:00Z'),
  ('a7610000-0000-4000-8000-000000000010', '00000000-0000-0000-0000-000000000001', 'in_progress', 'makesafe', 'JP-XZERO', false, '{}', '{}',
   NULL, '2026-08-01T00:00:00Z'),
  ('a7610000-0000-4000-8000-000000000011', '00000000-0000-0000-0000-000000000001', 'complete', 'makesafe', 'JP-IUN', false, '{}', '{}',
   NULL, '2026-08-01T00:00:00Z');

INSERT INTO public.work_orders (
  id, org_id, job_id, wo_number, kind, status, origin, agreed_labour_ex
) VALUES (
  'a7612000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'a7610000-0000-4000-8000-000000000001',
  'SWF-261397-DRAFT', 'job', 'draft', 'manual', 250.50
);

-- An approved job work order cannot be inserted while the seal trigger is on.
ALTER TABLE public.work_orders DISABLE TRIGGER trg_work_orders_job_kind_guard;
INSERT INTO public.work_orders (
  id, org_id, job_id, wo_number, kind, status, origin,
  agreed_labour_ex, approved_at, approved_by, sealed_content_hash
) VALUES
  ('a7612000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001',
   'a7610000-0000-4000-8000-000000000002', 'JP-WOOK-1', 'job', 'approved', 'manual',
   800, '2026-09-01T00:00:00Z', 'a7611000-0000-4000-8000-000000000001', repeat('a', 64)),
  ('a7612000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001',
   'a7610000-0000-4000-8000-000000000003', 'JP-WO0-1', 'job', 'approved', 'manual',
   0, '2026-09-01T00:00:00Z', 'a7611000-0000-4000-8000-000000000001', repeat('b', 64)),
  ('a7612000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000001',
   'a7610000-0000-4000-8000-000000000005', 'JP-XHOLD-1', 'job', 'approved', 'manual',
   8530, '2026-09-01T00:00:00Z', 'a7611000-0000-4000-8000-000000000001', repeat('c', 64)),
  ('a7612000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000001',
   'a7610000-0000-4000-8000-000000000004', 'JP-XDONE-1', 'job', 'approved', 'manual',
   0, '2026-09-01T00:00:00Z', 'a7611000-0000-4000-8000-000000000001', repeat('e', 64)),
  ('a7612000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000001',
   'a7610000-0000-4000-8000-000000000010', 'JP-XZERO-1', 'job', 'approved', 'manual',
   0, '2026-09-01T00:00:00Z', 'a7611000-0000-4000-8000-000000000001', repeat('f', 64));
ALTER TABLE public.work_orders ENABLE TRIGGER trg_work_orders_job_kind_guard;

INSERT INTO public.work_order_customer_variations (
  org_id, job_id, description, trade_allocation_ex, created_by
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  'a7610000-0000-4000-8000-000000000002',
  'Draft variation that must not count', 999, 'contract'
);

ALTER TABLE public.work_order_customer_variations DISABLE TRIGGER trg_work_order_customer_variations_guard;
INSERT INTO public.work_order_customer_variations (
  id, org_id, job_id, work_order_id, variation_number, status, description,
  trade_allocation_ex, customer_price_ex, created_by, approved_at, approved_by, sealed_content_hash
) VALUES (
  'a7613000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'a7610000-0000-4000-8000-000000000002',
  'a7612000-0000-4000-8000-000000000002',
  1, 'approved', 'Approved variation that counts',
  50, 80, 'contract', '2026-09-02T00:00:00Z',
  'a7611000-0000-4000-8000-000000000001', repeat('d', 64)
);
ALTER TABLE public.work_order_customer_variations ENABLE TRIGGER trg_work_order_customer_variations_guard;

INSERT INTO public.xero_invoices (
  org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name,
  sub_total, total, amount_paid, invoice_date, job_id, raw_json, line_items, reference
) VALUES
  ('00000000-0000-0000-0000-000000000001', 'BILL-JP-XDONE', 'BILL-JP-XDONE', 'ACCPAY', 'PAID', 'Supplies',
   300, 300, 300, '2026-08-02', 'a7610000-0000-4000-8000-000000000004', '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 300, "AccountCode": "306", "Description": "Install hand"}]', NULL),
  ('00000000-0000-0000-0000-000000000001', 'INV-JP-XDONE', 'INV-JP-XDONE', 'ACCREC', 'AUTHORISED', 'Client',
   10000, 11000, 0, '2026-08-08', 'a7610000-0000-4000-8000-000000000004', '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 10000, "AccountCode": "200", "Description": "Work"}]', NULL),
  ('00000000-0000-0000-0000-000000000001', 'BILL-JP-XHOLD', 'BILL-JP-XHOLD', 'ACCPAY', 'AUTHORISED', 'Supplies',
   80, 80, 0, '2026-08-02', 'a7610000-0000-4000-8000-000000000005', '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 80, "AccountCode": "306", "Description": "Install hand"}]', NULL),
  ('00000000-0000-0000-0000-000000000001', 'INV-JP-XHOLD', 'INV-JP-XHOLD', 'ACCREC', 'AUTHORISED', 'Client',
   10000, 11000, 0, '2026-08-08', 'a7610000-0000-4000-8000-000000000005', '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 10000, "AccountCode": "200", "Description": "Work"}]', NULL),
  ('00000000-0000-0000-0000-000000000001', 'BILL-JP-XZERO', 'BILL-JP-XZERO', 'ACCPAY', 'AUTHORISED', 'Supplies',
   100, 100, 0, '2026-08-02', 'a7610000-0000-4000-8000-000000000010', '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 100, "AccountCode": "310", "Description": "Sheets"}]', NULL),
  ('00000000-0000-0000-0000-000000000001', 'INV-JP-XZERO', 'INV-JP-XZERO', 'ACCREC', 'AUTHORISED', 'Client',
   10000, 11000, 0, '2026-08-08', 'a7610000-0000-4000-8000-000000000010', '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 10000, "AccountCode": "200", "Description": "Work"}]', NULL),
  ('00000000-0000-0000-0000-000000000001', 'BILL-JP-IMAT', 'BILL-JP-IMAT', 'ACCPAY', 'AUTHORISED', 'Supplies',
   1000, 1000, 0, '2026-08-02', 'a7610000-0000-4000-8000-000000000011', '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 1000, "AccountCode": "310", "Description": "Sheets"}]', NULL),
  ('00000000-0000-0000-0000-000000000001', 'BILL-JP-IUN', 'BILL-JP-IUN', 'ACCPAY', 'AUTHORISED', 'Installer',
   400, 400, 0, '2026-08-02', 'a7610000-0000-4000-8000-000000000011', '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 400, "AccountCode": "306", "Description": "Install"}]', NULL),
  ('00000000-0000-0000-0000-000000000001', 'INV-JP-IUN', 'INV-JP-IUN', 'ACCREC', 'AUTHORISED', 'Client',
   5000, 5500, 0, '2026-08-08', 'a7610000-0000-4000-8000-000000000011', '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 5000, "AccountCode": "200", "Description": "Work"}]', NULL);

INSERT INTO public.xero_projects (job_id, project_name, total_expenses, total_invoiced) VALUES
  ('a7610000-0000-4000-8000-000000000004', 'JP-XDONE site', 5000, 10000),
  ('a7610000-0000-4000-8000-000000000005', 'JP-XHOLD site', 5000, 10000),
  ('a7610000-0000-4000-8000-000000000010', 'JP-XZERO site', 5000, 10000);

INSERT INTO public.scope_revisions (
  id, job_id, revision_number, status, pricing_canonical_text, frozen_at
) VALUES
  ('a7640000-0000-4000-8000-000000000001', 'a7610000-0000-4000-8000-000000000006', 1, 'frozen',
   '{"totalExGST": 5000}', '2026-07-01T00:00:00Z'),
  ('a7640000-0000-4000-8000-000000000002', 'a7610000-0000-4000-8000-000000000007', 1, 'frozen',
   '{"totalExGST": 1000}', '2026-07-01T00:00:00Z'),
  ('a7640000-0000-4000-8000-000000000003', 'a7610000-0000-4000-8000-000000000008', 1, 'frozen',
   '{"totalExGST": 5000}', '2026-07-01T00:00:00Z');

INSERT INTO public.job_materials_facts (
  xero_invoice_id, job_id, job_number, lane, kind, amount_ex_gst, confidence, automation_source, fact_date
) VALUES
  ('BILL-JP-XDONE', 'a7610000-0000-4000-8000-000000000004', 'JP-XDONE', 'labour', 'actual', 300, 'high_manual', 'manual_queue', '2026-08-02'),
  ('BILL-JP-XHOLD', 'a7610000-0000-4000-8000-000000000005', 'JP-XHOLD', 'labour', 'actual', 80, 'high_manual', 'manual_queue', '2026-08-02');

DO $$
DECLARE
  r public.v_job_profit%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'SWF-261397';
  IF r.expected_labour_ex IS DISTINCT FROM 160
     OR r.expected_source IS DISTINCT FROM 'frozen_at_acceptance'
     OR r.work_order_agreed_labour_ex IS NOT NULL
     OR r.expected_labour_quote_ex IS DISTINCT FROM 160 THEN
    RAISE EXCEPTION 'draft WO counted while flags off: labour % source % agreed % quote %',
      r.expected_labour_ex, r.expected_source, r.work_order_agreed_labour_ex, r.expected_labour_quote_ex;
  END IF;

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP-WOOK';
  IF r.expected_labour_ex IS DISTINCT FROM 160
     OR r.work_order_agreed_labour_ex IS DISTINCT FROM 850
     OR r.expected_source IS DISTINCT FROM 'frozen_at_acceptance' THEN
    RAISE EXCEPTION 'approved WO changed expected labour while the switch is off: labour % agreed % source %',
      r.expected_labour_ex, r.work_order_agreed_labour_ex, r.expected_source;
  END IF;

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP-WO0';
  IF r.work_order_agreed_labour_ex IS DISTINCT FROM 0 OR r.expected_labour_ex IS DISTINCT FROM 100 THEN
    RAISE EXCEPTION 'approved zero was not kept as evidence while the switch is off: agreed % labour %',
      r.work_order_agreed_labour_ex, r.expected_labour_ex;
  END IF;

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP-XDONE';
  IF r.profit_ex IS NOT NULL OR r.margin_source IS NOT NULL OR r.margin_cost_ex IS NOT NULL
     OR r.cost_flag IS DISTINCT FROM 'xero_project_exceeds_line_costs'
     OR r.actual_cost_ex IS DISTINCT FROM 300
     OR 'margin_from_xero_project' = ANY (r.completeness)
     OR 'xero_project_margin_held' = ANY (r.completeness)
     OR NOT ('xero_project_exceeds_line_costs' = ANY (r.completeness)) THEN
    RAISE EXCEPTION 'project margin published while the switch is off: profit % flag % completeness %',
      r.profit_ex, r.cost_flag, r.completeness;
  END IF;

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'SWP-261247';
  IF r.quoted_ex IS NOT NULL OR 'patio_sales_price_conflict' = ANY (r.completeness) THEN
    RAISE EXCEPTION 'patio conflict published while the switch is off: quoted % completeness %',
      r.quoted_ex, r.completeness;
  END IF;

  -- JP-12 on the final view, with every switch still off.
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP-IUN';
  IF r.margin_ok OR r.profit_ex IS NOT NULL OR r.margin_pct IS NOT NULL
     OR r.actual_labour_ex IS DISTINCT FROM 0
     OR r.actual_materials_ex IS DISTINCT FROM 1000
     OR r.actual_cost_ex IS DISTINCT FROM 1000
     OR r.cost_flag IS DISTINCT FROM 'installer_bill_unconfirmed'
     OR NOT ('installer_bill_unconfirmed' = ANY (r.completeness)) THEN
    RAISE EXCEPTION 'unconfirmed installer bill published a margin while switches were off: margin_ok % profit % labour % materials % cost % flag % completeness %',
      r.margin_ok, r.profit_ex, r.actual_labour_ex, r.actual_materials_ex,
      r.actual_cost_ex, r.cost_flag, r.completeness;
  END IF;

  INSERT INTO public.job_materials_facts (
    xero_invoice_id, job_id, job_number, lane, kind, amount_ex_gst, confidence, automation_source, fact_date
  ) VALUES (
    'BILL-JP-IUN', 'a7610000-0000-4000-8000-000000000011', 'JP-IUN', 'labour', 'actual',
    400, 'high_manual', 'manual_queue', '2026-08-02'
  );
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP-IUN';
  IF r.margin_ok IS DISTINCT FROM true
     OR r.profit_ex IS DISTINCT FROM 3600
     OR r.actual_labour_ex IS DISTINCT FROM 400
     OR r.actual_cost_ex IS DISTINCT FROM 1400
     OR r.cost_flag IS DISTINCT FROM 'ok'
     OR 'installer_bill_unconfirmed' = ANY (COALESCE(r.completeness, '{}'::text[])) THEN
    RAISE EXCEPTION 'person-placed installer bill did not return the margin: margin_ok % profit % labour % cost % flag % completeness %',
      r.margin_ok, r.profit_ex, r.actual_labour_ex, r.actual_cost_ex, r.cost_flag, r.completeness;
  END IF;

  UPDATE public.feature_flags SET enabled = true
  WHERE flag_name IN (
    'job_profit_work_order_labour_v1',
    'job_profit_xero_project_cost_v1',
    'job_profit_patio_quote_v1'
  );

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'SWF-261397';
  IF r.expected_labour_ex IS DISTINCT FROM 160
     OR r.expected_labour_ex IS NOT DISTINCT FROM 250.50
     OR r.work_order_agreed_labour_ex IS NOT NULL
     OR r.expected_source IS DISTINCT FROM 'frozen_at_acceptance'
     OR r.expected_labour_quote_ex IS DISTINCT FROM 160 THEN
    RAISE EXCEPTION 'draft WO with agreed 250.50 was not ignored: labour % agreed % source % quote %',
      r.expected_labour_ex, r.work_order_agreed_labour_ex, r.expected_source, r.expected_labour_quote_ex;
  END IF;

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP-WOOK';
  IF r.expected_labour_ex IS DISTINCT FROM 850
     OR r.expected_source IS DISTINCT FROM 'job_work_order'
     OR r.expected_labour_quote_ex IS DISTINCT FROM 160
     OR r.work_order_agreed_labour_ex IS DISTINCT FROM 850
     OR r.expected_cost_ex IS DISTINCT FROM 900 THEN
    RAISE EXCEPTION 'approved WO plus variation did not become expected labour: labour % source % quote % agreed % cost %',
      r.expected_labour_ex, r.expected_source, r.expected_labour_quote_ex,
      r.work_order_agreed_labour_ex, r.expected_cost_ex;
  END IF;

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP-WO0';
  IF r.expected_labour_ex IS DISTINCT FROM 0
     OR r.expected_source IS DISTINCT FROM 'job_work_order'
     OR r.work_order_agreed_labour_ex IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'approved zero was not a real expected labour figure: labour % source % agreed %',
      r.expected_labour_ex, r.expected_source, r.work_order_agreed_labour_ex;
  END IF;

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP-XDONE';
  IF r.profit_ex IS DISTINCT FROM 5000
     OR r.margin_pct IS DISTINCT FROM 50.0
     OR r.margin_source IS DISTINCT FROM 'from Xero Project, may exclude unlinked labour'
     OR r.margin_cost_ex IS DISTINCT FROM 5000
     OR r.cost_flag IS DISTINCT FROM 'ok'
     OR r.work_order_agreed_labour_ex IS DISTINCT FROM 0
     OR r.actual_cost_ex IS DISTINCT FROM 300
     OR r.profit_ex_unsuppressed IS NOT NULL
     OR r.margin_ok IS DISTINCT FROM true
     OR NOT ('margin_from_xero_project' = ANY (r.completeness))
     OR 'xero_project_exceeds_line_costs' = ANY (r.completeness)
     OR 'xero_project_margin_held' = ANY (r.completeness) THEN
    RAISE EXCEPTION 'finished project margin did not publish cleanly: profit % source % flag % cost % completeness % unsuppressed %',
      r.profit_ex, r.margin_source, r.cost_flag, r.actual_cost_ex, r.completeness, r.profit_ex_unsuppressed;
  END IF;

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP-XHOLD';
  IF r.profit_ex IS NOT NULL
     OR r.margin_source IS NOT NULL
     OR r.cost_flag IS DISTINCT FROM 'xero_project_exceeds_line_costs'
     OR r.work_order_agreed_labour_ex IS DISTINCT FROM 8530
     OR r.actual_labour_ex IS DISTINCT FROM 80
     OR NOT ('xero_project_exceeds_line_costs' = ANY (r.completeness))
     OR NOT ('xero_project_margin_held' = ANY (r.completeness))
     OR 'margin_from_xero_project' = ANY (r.completeness) THEN
    RAISE EXCEPTION 'in-progress project margin was not held: profit % source % flag % labour % agreed % completeness %',
      r.profit_ex, r.margin_source, r.cost_flag, r.actual_labour_ex,
      r.work_order_agreed_labour_ex, r.completeness;
  END IF;

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP-XZERO';
  IF r.profit_ex IS NOT NULL
     OR r.margin_source IS NOT NULL
     OR r.margin_cost_ex IS NOT NULL
     OR r.cost_flag IS DISTINCT FROM 'xero_project_exceeds_line_costs'
     OR r.work_order_agreed_labour_ex IS DISTINCT FROM 0
     OR r.actual_labour_ex IS DISTINCT FROM 0
     OR r.margin_ok IS DISTINCT FROM false
     OR NOT ('xero_project_exceeds_line_costs' = ANY (r.completeness))
     OR NOT ('xero_project_margin_held' = ANY (r.completeness))
     OR 'margin_from_xero_project' = ANY (r.completeness) THEN
    RAISE EXCEPTION 'zero agreed labour published a project margin: profit % source % flag % labour % agreed % completeness %',
      r.profit_ex, r.margin_source, r.cost_flag, r.actual_labour_ex,
      r.work_order_agreed_labour_ex, r.completeness;
  END IF;

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'SWP-261247';
  IF r.quoted_ex IS NOT NULL OR r.quoted_source IS NOT NULL
     OR NOT ('patio_sales_price_conflict' = ANY (r.completeness)) THEN
    RAISE EXCEPTION 'SWP-261247 was not blank and flagged: quoted % source % completeness %',
      r.quoted_ex, r.quoted_source, r.completeness;
  END IF;

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'SWP-26100';
  IF r.quoted_ex IS NOT NULL OR r.quoted_source IS NOT NULL
     OR NOT ('patio_sales_price_conflict' = ANY (r.completeness)) THEN
    RAISE EXCEPTION 'SWP-26100 was not blank and flagged: quoted % source % completeness %',
      r.quoted_ex, r.quoted_source, r.completeness;
  END IF;

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP-POK';
  IF r.quoted_ex IS DISTINCT FROM 5000
     OR r.quoted_source IS DISTINCT FROM 'patio_quote:sole_frozen_revision'
     OR 'patio_sales_price_conflict' = ANY (r.completeness) THEN
    RAISE EXCEPTION 'sole frozen patio quote was not published: quoted % source % completeness %',
      r.quoted_ex, r.quoted_source, r.completeness;
  END IF;

  UPDATE public.feature_flags SET enabled = false
  WHERE flag_name IN (
    'job_profit_work_order_labour_v1',
    'job_profit_xero_project_cost_v1',
    'job_profit_patio_quote_v1'
  );
END $$;

ROLLBACK;
