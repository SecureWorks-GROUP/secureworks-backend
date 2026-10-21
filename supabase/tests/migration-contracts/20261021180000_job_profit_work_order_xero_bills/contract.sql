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
--   Bills       installer bills, a bill that already has a materials fact, a
--               sales invoice, a voided bill, a deleted bill, a bill already
--               linked to a job, and a trade-app bill are refused. None of
--               them writes a proposal or sets xero_invoices.job_id.
--               SWF-261041,SWF-261042 is two tokens. Linking it as one job
--               is refused. An exact token and a spaced two-job bill write a
--               proposal and never set xero_invoices.job_id.
--               A proposal surviving xero-sync's bill prematch is not tested
--               here: that sync supersedes another writer's hash, and keeping
--               these rows needs a change in that sync.

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
   NULL, '2026-08-01T00:00:00Z'),
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
   '[{"LineAmount": 60, "AccountCode": "305", "Description": "SWF-261111 and SWP-261247"}]', NULL),
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
   '[{"LineAmount": 5000, "AccountCode": "200", "Description": "Work"}]', NULL),
  ('00000000-0000-0000-0000-000000000001', 'BILL-SALES', 'BILL-SALES', 'ACCREC', 'AUTHORISED', 'Client',
   80, 88, 0, '2026-08-02', NULL, '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 80, "AccountCode": "200", "Description": "SWF-261111"}]', 'SWF-261111'),
  ('00000000-0000-0000-0000-000000000001', 'BILL-VOID', 'BILL-VOID', 'ACCPAY', 'VOIDED', 'Supplier',
   15, 15, 0, '2026-08-02', NULL, '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 15, "AccountCode": "305", "Description": "Posts"}]', 'SWF-261111'),
  ('00000000-0000-0000-0000-000000000001', 'BILL-GONE', 'BILL-GONE', 'ACCPAY', 'DELETED', 'Supplier',
   15, 15, 0, '2026-08-02', NULL, '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 15, "AccountCode": "305", "Description": "Posts"}]', 'SWF-261111'),
  ('00000000-0000-0000-0000-000000000001', 'BILL-LINKED', 'BILL-LINKED', 'ACCPAY', 'AUTHORISED', 'Supplier',
   15, 15, 0, '2026-08-02', 'a7610000-0000-4000-8000-000000000009', '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 15, "AccountCode": "305", "Description": "Posts"}]', 'SWF-261111'),
  ('00000000-0000-0000-0000-000000000001', 'BILL-TRADE', 'BILL-TRADE', 'ACCPAY', 'AUTHORISED', 'Trade',
   40, 40, 0, '2026-08-02', NULL, '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 40, "AccountCode": "305", "Description": "Posts"}]', 'SWF-261111'),
  ('00000000-0000-0000-0000-000000000001', 'BILL-TLINE', 'BILL-TLINE', 'ACCPAY', 'AUTHORISED', 'Trade',
   40, 40, 0, '2026-08-02', NULL, '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 40, "AccountCode": "305", "Description": "JOB | SW - FENCING"}]', 'SWF-261111'),
  ('00000000-0000-0000-0000-000000000001', 'BILL-ADJ', 'BILL-ADJ', 'ACCPAY', 'AUTHORISED', 'Supplier',
   30, 30, 0, '2026-08-02', NULL, '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 30, "AccountCode": "305", "Description": "Posts"}]', 'SWF-261041,SWF-261042');

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
  ('BILL-FACT', 'a7610000-0000-4000-8000-000000000009', 'SWF-261111', 'materials', 'actual', 40, 'high_manual', 'manual_queue', '2026-08-02'),
  ('BILL-JP-XDONE', 'a7610000-0000-4000-8000-000000000004', 'JP-XDONE', 'labour', 'actual', 300, 'high_manual', 'manual_queue', '2026-08-02'),
  ('BILL-JP-XHOLD', 'a7610000-0000-4000-8000-000000000005', 'JP-XHOLD', 'labour', 'actual', 80, 'high_manual', 'manual_queue', '2026-08-02');

INSERT INTO public.trade_invoices (
  id, org_id, user_id, week_start, status, subtotal_ex, xero_bill_id, xero_bill_status, invoice_number,
  gst_on, gst, total_inc, super_rate, super_amount, gross_earned, net_pay
) VALUES (
  'a7614000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001',
  'a7611000-0000-4000-8000-000000000001', '2026-08-24', 'paid', 40, 'BILL-TRADE', 'PAID', 'TI-JP-1',
  false, 0, 40, 0.12, 4.8, 40, 35.2
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
  v_tokens text[];
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

  SELECT public.job_profit_bill_job_tokens('SWF-261041,SWF-261042', '[]'::jsonb) INTO v_tokens;
  IF v_tokens IS DISTINCT FROM ARRAY['SWF-261041', 'SWF-261042']::text[] THEN
    RAISE EXCEPTION 'adjacent job numbers were not both tokens: %', v_tokens;
  END IF;
  SELECT public.job_profit_bill_job_tokens('SWF-261111', '[]'::jsonb) INTO v_tokens;
  IF v_tokens IS DISTINCT FROM ARRAY['SWF-261111']::text[] THEN
    RAISE EXCEPTION 'a single six-digit job number was split or missed: %', v_tokens;
  END IF;
  BEGIN
    PERFORM public.job_profit_link_bill(
      'BILL-ADJ', 'job', 'SWF-261041', 'SWF-261041,SWF-261042', 'job_profit_bill_match', 'contract', 'contract'
    );
    RAISE EXCEPTION 'a bill naming two adjacent job numbers was linked as one job';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%link_refused: job token set does not match the bill%' THEN
        RAISE;
      END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.materials_bill_proposals p WHERE p.xero_invoice_id = 'BILL-ADJ') THEN
    RAISE EXCEPTION 'adjacent job numbers wrote a proposal when linked as one job';
  END IF;

  FOREACH v_msg IN ARRAY ARRAY[
    'BILL-SALES', 'BILL-VOID', 'BILL-GONE', 'BILL-LINKED', 'BILL-TRADE', 'BILL-TLINE'
  ] LOOP
    BEGIN
      PERFORM public.job_profit_link_bill(v_msg, 'job', 'SWF-261111', 'SWF-261111', 'job_profit_bill_match', 'contract', 'contract');
      RAISE EXCEPTION '% was not refused', v_msg;
    EXCEPTION
      WHEN OTHERS THEN
        IF v_msg = 'BILL-SALES' AND SQLERRM NOT LIKE '%link_refused: sales invoice%' THEN
          RAISE;
        ELSIF v_msg IN ('BILL-VOID', 'BILL-GONE') AND SQLERRM NOT LIKE '%link_refused: voided or deleted bill%' THEN
          RAISE;
        ELSIF v_msg = 'BILL-LINKED' AND SQLERRM NOT LIKE '%link_refused: bill already linked%' THEN
          RAISE;
        ELSIF v_msg IN ('BILL-TRADE', 'BILL-TLINE') AND SQLERRM NOT LIKE '%link_refused: trade app bill%' THEN
          RAISE;
        ELSIF v_msg NOT IN ('BILL-SALES', 'BILL-VOID', 'BILL-GONE', 'BILL-LINKED', 'BILL-TRADE', 'BILL-TLINE') THEN
          RAISE;
        END IF;
    END;
    IF EXISTS (SELECT 1 FROM public.materials_bill_proposals p WHERE p.xero_invoice_id = v_msg) THEN
      RAISE EXCEPTION '% wrote a proposal', v_msg;
    END IF;
  END LOOP;
  SELECT job_id INTO v_job FROM public.xero_invoices WHERE xero_invoice_id = 'BILL-SALES';
  IF v_job IS NOT NULL THEN
    RAISE EXCEPTION 'a sales invoice set xero_invoices.job_id';
  END IF;
  SELECT job_id INTO v_job FROM public.xero_invoices WHERE xero_invoice_id = 'BILL-LINKED';
  IF v_job IS DISTINCT FROM 'a7610000-0000-4000-8000-000000000009' THEN
    RAISE EXCEPTION 'an already-linked bill changed xero_invoices.job_id to %', v_job;
  END IF;

  UPDATE public.feature_flags SET enabled = false
  WHERE flag_name IN (
    'job_profit_work_order_labour_v1',
    'job_profit_xero_project_cost_v1',
    'job_profit_patio_quote_v1'
  );
END $$;

ROLLBACK;
