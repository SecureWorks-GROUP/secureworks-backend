-- Contract for 20261021180000_job_profit_work_order_xero_bills.
--
-- Synthetic jobs, fixed dates, no customer data. The three switches are
-- seeded off. This transaction turns them on, proves the new behaviour, and
-- rolls back, so a committed database stays off.
--
--   SWF-261397  draft job work order agreed 250.50. Ignored. Expected labour
--               stays the quote's 160 with the labour switch on or off.
--   JP-WOOK     approved job work order 800 plus an approved variation of 50.
--               A draft variation of 999 is not added. Flag off: expected
--               labour stays 160, and the agreed figure is still shown.
--               Flag on: expected labour is 850, source job_work_order.
--   JP-WO0      approved agreed labour 0 is a real figure.
--   JP-XDONE    finished makesafe. Project 5000 above labour 300, invoiced
--               10000. Flag off: margin null and the suppressor stays.
--               Flag on: margin uses 5000, the exact project label, cost_flag
--               ok, and the suppressor is not set.
--   JP-XHOLD    in progress, billed labour 80 under agreed 8530. Flag on:
--               the project margin stays blank and the suppressor stays.
--   SWP-261247  frozen 5000 against live 9382: blank and flagged.
--   SWP-26100   frozen 1000 against live 2000: blank and flagged.
--   JP-POK      one frozen 5000, no live price, nothing invoiced past it:
--               published only while the patio switch is on.
--   Bills       an installer bill and a bill that already has a materials
--               fact are refused. An exact token and a two-job bill write a
--               proposal and never set xero_invoices.job_id.

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
  ('a7610000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000001', 'archived', 'fencing', 'SWF-261111', false, '{}', '{}',
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
   8530, '2026-09-01T00:00:00Z', 'a7611000-0000-4000-8000-000000000001', repeat('c', 64));
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
  ('00000000-0000-0000-0000-000000000001', 'BILL-INST', 'BILL-INST', 'ACCPAY', 'AUTHORISED', 'Alyx Smuts',
   450, 450, 0, '2026-08-02', NULL, '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 450, "AccountCode": "306", "Description": "SWF-26698 Fence Installation"}]', 'SWF-26698'),
  ('00000000-0000-0000-0000-000000000001', 'BILL-INST301', 'BILL-INST301', 'ACCPAY', 'AUTHORISED', 'Installer',
   100, 100, 0, '2026-08-02', NULL, '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 100, "AccountCode": "301", "Description": "SWF-261111 labour"}]', 'SWF-261111'),
  ('00000000-0000-0000-0000-000000000001', 'BILL-FACT', 'BILL-FACT', 'ACCPAY', 'AUTHORISED', 'Supplier',
   40, 40, 0, '2026-08-02', NULL, '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 40, "AccountCode": "305", "Description": "SWF-261111 materials"}]', 'SWF-261111'),
  ('00000000-0000-0000-0000-000000000001', 'BILL-EXACT', 'BILL-EXACT', 'ACCPAY', 'AUTHORISED', 'Supplier',
   25, 25, 0, '2026-08-02', NULL, '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 25, "AccountCode": "305", "Description": "Posts"}]', 'SWF-261111'),
  ('00000000-0000-0000-0000-000000000001', 'BILL-SPLIT', 'BILL-SPLIT', 'ACCPAY', 'AUTHORISED', 'Supplier',
   60, 60, 0, '2026-08-02', NULL, '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 60, "AccountCode": "305", "Description": "SWF-261111 and SWP-261247"}]', NULL);

INSERT INTO public.xero_projects (job_id, project_name, total_expenses, total_invoiced) VALUES
  ('a7610000-0000-4000-8000-000000000004', 'JP-XDONE site', 5000, 10000),
  ('a7610000-0000-4000-8000-000000000005', 'JP-XHOLD site', 5000, 10000);

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
  xero_invoice_id, job_id, lane, amount_ex_gst, automation_source
) VALUES (
  'BILL-FACT', 'a7610000-0000-4000-8000-000000000009', 'materials', 40, 'manual_queue'
);

DO $$
DECLARE
  r public.v_job_profit%ROWTYPE;
  v_msg text;
  v_job uuid;
  n int;
  v_kind text;
  v_number text;
  v_outcome text;
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

  FOREACH v_msg IN ARRAY ARRAY['BILL-INST', 'BILL-INST301'] LOOP
    BEGIN
      PERFORM public.job_profit_link_bill(v_msg, 'job', 'SWF-261111', v_msg, 'job_profit_bill_match', 'contract', 'contract');
      RAISE EXCEPTION 'installer bill % was not refused', v_msg;
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%link_refused: installer bill%' THEN
          RAISE;
        END IF;
    END;
    IF EXISTS (SELECT 1 FROM public.materials_bill_proposals p WHERE p.xero_invoice_id = v_msg) THEN
      RAISE EXCEPTION 'installer bill % wrote a proposal', v_msg;
    END IF;
    SELECT i.job_id INTO v_job FROM public.xero_invoices i WHERE i.xero_invoice_id = v_msg;
    IF v_job IS NOT NULL THEN
      RAISE EXCEPTION 'installer bill % set xero_invoices.job_id', v_msg;
    END IF;
  END LOOP;

  BEGIN
    PERFORM public.job_profit_link_bill('BILL-FACT', 'job', 'SWF-261111', 'SWF-261111', 'job_profit_bill_match', 'contract', 'contract');
    RAISE EXCEPTION 'a bill that already has a materials fact was not refused';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%link_refused: bill already has a materials fact%' THEN
        RAISE;
      END IF;
  END;
  SELECT count(*) INTO n FROM public.materials_bill_proposals WHERE xero_invoice_id = 'BILL-FACT';
  IF n <> 0 THEN
    RAISE EXCEPTION 'a fact-backed bill wrote a proposal';
  END IF;
  SELECT job_id INTO v_job FROM public.xero_invoices WHERE xero_invoice_id = 'BILL-FACT';
  IF v_job IS NOT NULL THEN
    RAISE EXCEPTION 'a fact-backed bill set xero_invoices.job_id';
  END IF;

  PERFORM public.job_profit_link_bill(
    'BILL-EXACT', 'job', 'SWF-261111', 'SWF-261111', 'job_profit_bill_match', 'contract', 'contract'
  );
  SELECT proposal_kind, proposed_job_number, outcome
    INTO v_kind, v_number, v_outcome
  FROM public.materials_bill_proposals
  WHERE xero_invoice_id = 'BILL-EXACT' AND outcome <> 'superseded';
  IF v_kind IS DISTINCT FROM 'job' OR v_number IS DISTINCT FROM 'SWF-261111'
     OR v_outcome IS DISTINCT FROM 'queued_for_review' THEN
    RAISE EXCEPTION 'exact bill proposal was % % %', v_kind, v_number, v_outcome;
  END IF;
  SELECT job_id INTO v_job FROM public.xero_invoices WHERE xero_invoice_id = 'BILL-EXACT';
  IF v_job IS NOT NULL THEN
    RAISE EXCEPTION 'exact bill set xero_invoices.job_id';
  END IF;

  PERFORM public.job_profit_link_bill(
    'BILL-SPLIT', 'review', NULL, 'SWF-261111 SWP-261247', 'job_profit_bill_match', 'contract', 'contract'
  );
  SELECT proposal_kind, proposed_job_number, outcome
    INTO v_kind, v_number, v_outcome
  FROM public.materials_bill_proposals
  WHERE xero_invoice_id = 'BILL-SPLIT' AND outcome <> 'superseded';
  IF v_kind IS DISTINCT FROM 'review' OR v_number IS NOT NULL
     OR v_outcome IS DISTINCT FROM 'queued_for_review' THEN
    RAISE EXCEPTION 'two-job bill proposal was % % %', v_kind, v_number, v_outcome;
  END IF;
  SELECT job_id INTO v_job FROM public.xero_invoices WHERE xero_invoice_id = 'BILL-SPLIT';
  IF v_job IS NOT NULL THEN
    RAISE EXCEPTION 'two-job bill set xero_invoices.job_id';
  END IF;

  UPDATE public.feature_flags SET enabled = false
  WHERE flag_name IN (
    'job_profit_work_order_labour_v1',
    'job_profit_xero_project_cost_v1',
    'job_profit_patio_quote_v1'
  );
END $$;

ROLLBACK;
