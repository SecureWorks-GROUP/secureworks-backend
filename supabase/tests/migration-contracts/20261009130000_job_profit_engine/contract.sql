-- Contract for 20261009130000_job_profit_engine (job profitability PR 1).
--
-- Synthetic jobs, fixed dates, no customer data. Everything rolls back.
--   JP-FENCE  line-level costs from every source, the exclusions (ops-rejected
--             and Xero-deleted trade invoices, QA test line, trade-mirror bills
--             by id and by the app's line format, a deleted bill), inclusive
--             GST lines, a draft and a voided sales invoice, all variation
--             states with only agreed values summed, an open PO, frozen
--             expected costs and a sent quote.
--   JP-PROJ   Xero Project total larger than line-level: materials inferred.
--   JP-DBL    trade lines larger than the project total: stays line-level,
--             flags project_below_trade_lines, and a negative materials
--             deduction cannot publish a labour-only margin.
--   JP-MS     make-safe roof report with no client invoice and a trade line
--             found by job number: margin suppressed, flags carried.
--   JP-OLD    legacy job: not in the engine.

\set ON_ERROR_STOP on

-- ── Grants: money reads are service role only ─────────────────────────────
DO $$
DECLARE
  v text;
BEGIN
  FOREACH v IN ARRAY ARRAY['public.v_job_cost_events', 'public.v_job_revenue_events', 'public.v_job_profit'] LOOP
    IF has_table_privilege('anon', v, 'SELECT') THEN RAISE EXCEPTION 'jp grants: anon can read %', v; END IF;
    IF has_table_privilege('authenticated', v, 'SELECT') THEN RAISE EXCEPTION 'jp grants: authenticated can read %', v; END IF;
    IF NOT has_table_privilege('service_role', v, 'SELECT') THEN RAISE EXCEPTION 'jp grants: service_role cannot read %', v; END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.job_profit(uuid)', 'EXECUTE') THEN RAISE EXCEPTION 'jp grants: anon can execute job_profit'; END IF;
  IF has_function_privilege('authenticated', 'public.job_profit(uuid)', 'EXECUTE') THEN RAISE EXCEPTION 'jp grants: authenticated can execute job_profit'; END IF;
  IF NOT has_function_privilege('service_role', 'public.job_profit(uuid)', 'EXECUTE') THEN RAISE EXCEPTION 'jp grants: service_role cannot execute job_profit'; END IF;
END $$;

-- ── job_profit_num: numbers and plain decimal strings only, never 0 ────────
DO $$
BEGIN
  IF public.job_profit_num('12.5'::jsonb) IS DISTINCT FROM 12.5 THEN RAISE EXCEPTION 'jp num: number'; END IF;
  IF public.job_profit_num('"40.25"'::jsonb) IS DISTINCT FROM 40.25 THEN RAISE EXCEPTION 'jp num: decimal string'; END IF;
  IF public.job_profit_num('"$40"'::jsonb) IS NOT NULL THEN RAISE EXCEPTION 'jp num: malformed string must be null'; END IF;
  IF public.job_profit_num('null'::jsonb) IS NOT NULL THEN RAISE EXCEPTION 'jp num: json null must be null'; END IF;
  IF public.job_profit_num(NULL) IS NOT NULL THEN RAISE EXCEPTION 'jp num: sql null must be null'; END IF;
END $$;

BEGIN;

INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, pricing_json, expected_costs, created_at) VALUES
  ('a7000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'JP-FENCE', false, '{}',
   '{"totalExGST": 999, "totalCostEstimate": 1, "labourCostEstimate": 1}',
   '{"lanes": {"labour": {"amount_ex_gst": 250}, "materials": {"amount_ex_gst": 150}, "commission": {"amount_ex_gst": 90}}}',
   '2026-08-01T00:00:00Z'),
  ('a7000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'complete', 'patio', 'JP-PROJ', false, '{}',
   '{"totalExGST": 1400, "totalCostEstimate": 1, "labourCostEstimate": 1, "materialCostEstimate": 1}', NULL,
   '2026-08-01T00:00:00Z'),
  ('a7000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'JP-DBL', false, '{}',
   '{"totalExGST": "900", "totalCostEstimate": 500, "labourCostEstimate": 200, "materialCostEstimate": "250", "commissionCostEstimate": 50}', NULL,
   '2026-08-01T00:00:00Z'),
  ('a7000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000001', 'archived', 'makesafe', 'JP-MS', false,
   '{"ses_family": "roof_report"}', NULL, NULL, '2026-08-01T00:00:00Z'),
  ('a7000000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'JP-OLD', true, '{}', NULL, NULL,
   '2026-08-01T00:00:00Z');

INSERT INTO public.users (id, org_id, name) VALUES
  ('a7100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'Trade One');

-- Trade invoices carry the 2026-09-18 money split (gst off, 12% super,
-- 6% withheld). T1 paid, T2 ops-rejected, T3 Xero bill deleted, T4 a QA test
-- line, T5 approved and pushed, not yet paid, T6 paid, T7 a trade's empty day
-- still awaiting acknowledgment (zero value).
INSERT INTO public.trade_invoices (id, org_id, user_id, week_start, status, subtotal_ex, xero_bill_id, xero_bill_status, invoice_number, paid_at,
                                   gst_on, gst, total_inc, super_rate, super_amount, gross_earned, net_pay) VALUES
  ('a7200000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'a7100000-0000-4000-8000-000000000001', '2026-08-03', 'paid', 400, 'BILL-T1', 'PAID', 'SW-INV-T1', '2026-08-20',
   false, 0, 400, 0.12, 48, 400, 376),
  ('a7200000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'a7100000-0000-4000-8000-000000000001', '2026-08-03', 'ops-reject', 50, NULL, NULL, 'SW-INV-T2', NULL,
   false, 0, 50, 0.12, 6, 50, 47),
  ('a7200000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'a7100000-0000-4000-8000-000000000001', '2026-08-03', 'pushed_to_xero', 70, 'BILL-T3', 'DELETED', 'SW-INV-T3', NULL,
   false, 0, 70, 0.12, 8.4, 70, 65.8),
  ('a7200000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000001', 'a7100000-0000-4000-8000-000000000001', '2026-08-03', 'paid', 40, 'BILL-T4', 'PAID', 'SW-INV-T4', '2026-08-20',
   false, 0, 40, 0.12, 4.8, 40, 37.6),
  ('a7200000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000001', 'a7100000-0000-4000-8000-000000000001', '2026-08-03', 'pushed_to_xero', 420, 'BILL-T5', 'AUTHORISED', 'SW-INV-T5', NULL,
   false, 0, 420, 0.12, 50.4, 420, 394.8),
  ('a7200000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000001', 'a7100000-0000-4000-8000-000000000001', '2026-08-03', 'paid', 300, 'BILL-T6', 'PAID', 'SW-INV-T6', '2026-08-25',
   false, 0, 300, 0.12, 36, 300, 282),
  ('a7200000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000001', 'a7100000-0000-4000-8000-000000000001', '2026-08-03', 'pending_acknowledgment', 0, NULL, NULL, 'SW-INV-T7', NULL,
   false, 0, 0, 0.12, 0, 0, 0);

INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, job_number, line_type, description, line_total_ex, total_hours, line_date) VALUES
  ('a7200000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', NULL, 'labour', 'Fence labour', 300, 6, '2026-08-04'),
  ('a7200000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', NULL, 'commission', 'Commission', 100, NULL, '2026-08-04'),
  ('a7200000-0000-4000-8000-000000000002', 'a7000000-0000-4000-8000-000000000001', NULL, 'labour', 'Rejected labour', 50, 1, '2026-08-04'),
  ('a7200000-0000-4000-8000-000000000003', 'a7000000-0000-4000-8000-000000000001', NULL, 'labour', 'Deleted bill labour', 70, 2, '2026-08-04'),
  ('a7200000-0000-4000-8000-000000000004', 'a7000000-0000-4000-8000-000000000001', NULL, 'labour', 'QA TEST line', 40, 1, '2026-08-04'),
  ('a7200000-0000-4000-8000-000000000005', 'a7000000-0000-4000-8000-000000000002', NULL, 'labour', 'Patio labour', 300, 6, '2026-08-05'),
  ('a7200000-0000-4000-8000-000000000006', 'a7000000-0000-4000-8000-000000000003', NULL, 'labour', 'Fence labour', 300, 6, '2026-08-05'),
  ('a7200000-0000-4000-8000-000000000007', 'a7000000-0000-4000-8000-000000000003', NULL, 'labour', NULL, 0, 0, '2026-08-05'),
  ('a7200000-0000-4000-8000-000000000006', 'a7000000-0000-4000-8000-000000000003', NULL, 'materials', 'Materials deduction', -40, NULL, '2026-08-05'),
  ('a7200000-0000-4000-8000-000000000005', NULL, 'JP-MS', 'make safe', 'Roof report attendance', 120, 2, '2026-08-06');

INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, amount_paid, invoice_date, fully_paid_on, job_id, raw_json, line_items) VALUES
  -- the trade app's own bill for T1: mirror by id, never a supplier cost
  ('00000000-0000-0000-0000-000000000001', 'BILL-T1', 'SW-INV-T1', 'ACCPAY', 'PAID', 'Trade One', 400, 400, 400, '2026-08-10', '2026-08-20',
   'a7000000-0000-4000-8000-000000000001', '{"LineAmountTypes": "NoTax"}',
   '[{"LineAmount": 400, "AccountCode": "306", "Description": "JP-FENCE labour"}]'),
  -- an app-format bill whose id the app never stored: mirror by line format
  ('00000000-0000-0000-0000-000000000001', 'BILL-APP', 'X-1', 'ACCPAY', 'PAID', 'Trade One', 999, 999, 999, '2026-08-10', '2026-08-20',
   'a7000000-0000-4000-8000-000000000001', '{"LineAmountTypes": "NoTax"}',
   '[{"LineAmount": 999, "AccountCode": "306", "Description": "POSSIBLE DUPLICATE\nJP-FENCE | SW - FENCING\nLabour"}]'),
  -- a real supplier bill, GST inclusive lines: 100 materials + 50 labour ex GST
  ('00000000-0000-0000-0000-000000000001', 'BILL-S1', 'S-1', 'ACCPAY', 'PAID', 'Fence Supplies', 150, 165, 165, '2026-08-02', '2026-08-15',
   'a7000000-0000-4000-8000-000000000001', '{"LineAmountTypes": "Inclusive"}',
   '[{"LineAmount": 110, "TaxAmount": 10, "AccountCode": "305", "Description": "Sheets", "Tracking": [{"Name": "Business Unit", "Option": "SW - FENCING"}]},
     {"LineAmount": 55, "TaxAmount": 5, "AccountCode": "306", "Description": "Install hand"}]'),
  -- authorised, not paid; commission by description
  ('00000000-0000-0000-0000-000000000001', 'BILL-S2', 'S-2', 'ACCPAY', 'AUTHORISED', 'Sales Agent', 20, 22, 0, '2026-08-12', NULL,
   'a7000000-0000-4000-8000-000000000001', '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 20, "TaxAmount": 2, "AccountCode": "306", "Description": "Sales commission JP-FENCE"}]'),
  -- deleted bill: never a cost
  ('00000000-0000-0000-0000-000000000001', 'BILL-S3', 'S-3', 'ACCPAY', 'DELETED', 'Fence Supplies', 500, 550, 0, '2026-08-02', NULL,
   'a7000000-0000-4000-8000-000000000001', '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 500, "AccountCode": "305", "Description": "Deleted"}]'),
  -- sales: paid 1000, a draft 50, a voided 300
  ('00000000-0000-0000-0000-000000000001', 'INV-1', 'INV-1', 'ACCREC', 'PAID', 'Client', 1000, 1100, 1100, '2026-08-08', '2026-08-18',
   'a7000000-0000-4000-8000-000000000001', '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 1000, "TaxAmount": 100, "AccountCode": "200", "Description": "Fence", "Tracking": [{"Name": "Business Unit", "Option": "SW - FENCING"}]}]'),
  ('00000000-0000-0000-0000-000000000001', 'INV-2', 'INV-2', 'ACCREC', 'DRAFT', 'Client', 50, 55, 0, '2026-08-09', NULL,
   'a7000000-0000-4000-8000-000000000001', '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 50, "TaxAmount": 5, "AccountCode": "200", "Description": "Extra"}]'),
  ('00000000-0000-0000-0000-000000000001', 'INV-3', 'INV-3', 'ACCREC', 'VOIDED', 'Client', 300, 330, 0, '2026-08-09', NULL,
   'a7000000-0000-4000-8000-000000000001', '{"LineAmountTypes": "Exclusive"}',
   '[{"LineAmount": 300, "AccountCode": "200", "Description": "Voided"}]'),
  -- JP-PROJ and JP-DBL: authorised, not paid, no lines stored (header fallback)
  ('00000000-0000-0000-0000-000000000001', 'INV-4', 'INV-4', 'ACCREC', 'AUTHORISED', 'Client', 1500, 1650, 550, '2026-08-08', NULL,
   'a7000000-0000-4000-8000-000000000002', NULL, '[]'),
  ('00000000-0000-0000-0000-000000000001', 'INV-5', 'INV-5', 'ACCREC', 'PAID', 'Client', 800, 880, 880, '2026-08-08', '2026-08-28',
   'a7000000-0000-4000-8000-000000000003', NULL, '[{"LineAmount": 800, "AccountCode": "200", "Description": "Fence"}]');

INSERT INTO public.xero_projects (job_id, total_expenses, total_invoiced) VALUES
  ('a7000000-0000-4000-8000-000000000002', 1000, 1500),
  ('a7000000-0000-4000-8000-000000000003', 200, 800);

INSERT INTO public.job_variations (job_id, variation_number, description, amount, gst_included, status, accepted_at, declined_at, created_at) VALUES
  ('a7000000-0000-4000-8000-000000000001', 1, 'Approved internally only', 110, true, 'approved', NULL, NULL, '2026-08-07T00:00:00Z'),
  ('a7000000-0000-4000-8000-000000000001', 2, 'Customer accepted', 220, true, 'accepted', NULL, NULL, '2026-08-08T00:00:00Z'),
  ('a7000000-0000-4000-8000-000000000001', 3, 'Invoiced variation', 55, false, 'invoiced', NULL, NULL, '2026-08-09T00:00:00Z'),
  ('a7000000-0000-4000-8000-000000000001', 4, 'Accepted timestamp', 33, false, 'approved', '2026-08-10T00:00:00Z', NULL, '2026-08-10T00:00:00Z'),
  ('a7000000-0000-4000-8000-000000000001', 5, 'Sent only', 110, true, 'sent', NULL, NULL, '2026-08-11T00:00:00Z'),
  ('a7000000-0000-4000-8000-000000000001', 6, 'Declined variation', 77, false, 'declined', NULL, NULL, '2026-08-12T00:00:00Z'),
  ('a7000000-0000-4000-8000-000000000001', 7, 'Rejected variation', 88, false, 'rejected', NULL, NULL, '2026-08-13T00:00:00Z'),
  ('a7000000-0000-4000-8000-000000000001', 8, 'Pending variation', 99, false, 'pending_approval', NULL, NULL, '2026-08-14T00:00:00Z'),
  ('a7000000-0000-4000-8000-000000000001', 9, 'Accepted then declined', 66, false, 'accepted', '2026-08-15T00:00:00Z', '2026-08-16T00:00:00Z', '2026-08-15T00:00:00Z');

INSERT INTO public.purchase_orders (job_id, po_number, supplier_name, status, subtotal, total, created_at) VALUES
  ('a7000000-0000-4000-8000-000000000001', 'PO-OPEN', 'Fence Supplies', 'sent', 80, 88, '2026-08-01T00:00:00Z'),
  ('a7000000-0000-4000-8000-000000000001', 'PO-DRAFT', 'Fence Supplies', 'draft', 500, 550, '2026-08-01T00:00:00Z');

-- JP-FENCE sent quote: the sealed revision total 1320 inc GST.
INSERT INTO public.job_documents (id, job_id, type, sent_at, created_at) VALUES
  ('a7300000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', 'quote', '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z');
INSERT INTO public.quote_revisions (job_id, job_document_id, version, sent_at, released_via, totals_snapshot_json, internal_cost_snapshot_json) VALUES
  ('a7000000-0000-4000-8000-000000000001', 'a7300000-0000-4000-8000-000000000001', 1, '2026-07-20T00:00:00Z', 'send-quote/send',
   '{"total_inc_gst": 1320, "total_ex_gst": 1200}',
   '{"cost_estimates": {"labour_total": 1, "material_total": 1, "subcontract_commission_total": 1}}');

-- JP-PROJ: an accepted quote document whose revision carries cost estimates.
INSERT INTO public.job_documents (id, job_id, type, sent_at, accepted_at, created_at) VALUES
  ('a7300000-0000-4000-8000-000000000002', 'a7000000-0000-4000-8000-000000000002', 'quote', '2026-07-20T00:00:00Z', '2026-07-22T00:00:00Z', '2026-07-20T00:00:00Z');
INSERT INTO public.quote_revisions (job_id, job_document_id, version, sent_at, released_via, totals_snapshot_json, internal_cost_snapshot_json) VALUES
  ('a7000000-0000-4000-8000-000000000002', 'a7300000-0000-4000-8000-000000000002', 1, '2026-07-20T00:00:00Z', 'send-quote/send',
   '{"total_inc_gst": 1650, "total_ex_gst": 1500}',
   '{"cost_estimates": {"labour_total": 400, "material_total": 500, "subcontract_commission_total": 60}}');

-- ── Cost events ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  r record;
BEGIN
  SELECT
    count(*) FILTER (WHERE source = 'trade_line') AS trade_n,
    count(*) FILTER (WHERE source = 'supplier_bill') AS bill_n,
    count(*) FILTER (WHERE source = 'po_committed') AS po_n,
    sum(amount_ex) FILTER (WHERE is_actual) AS actual,
    bool_or(document_id IN ('BILL-T1', 'BILL-APP', 'BILL-S3')) AS has_excluded_bill,
    bool_or(description IN ('Rejected labour', 'Deleted bill labour', 'QA TEST line')) AS has_excluded_line
  INTO r
  FROM public.v_job_cost_events
  WHERE job_id = 'a7000000-0000-4000-8000-000000000001';
  IF r.trade_n <> 2 THEN RAISE EXCEPTION 'jp cost: JP-FENCE trade lines %, expected 2 (rejected, deleted-bill and QA lines excluded)', r.trade_n; END IF;
  IF r.bill_n <> 3 THEN RAISE EXCEPTION 'jp cost: JP-FENCE supplier bill lines %, expected 3 (mirrors and deleted bill excluded)', r.bill_n; END IF;
  IF r.po_n <> 1 THEN RAISE EXCEPTION 'jp cost: JP-FENCE open POs %, expected 1 (draft excluded)', r.po_n; END IF;
  IF r.actual <> 570 THEN RAISE EXCEPTION 'jp cost: JP-FENCE actual %, expected 570', r.actual; END IF;
  IF r.has_excluded_bill THEN RAISE EXCEPTION 'jp cost: a trade-mirror or deleted bill counted'; END IF;
  IF r.has_excluded_line THEN RAISE EXCEPTION 'jp cost: a rejected, deleted-bill or QA trade line counted'; END IF;

  SELECT lane, amount_ex, business_unit, paid, paid_on INTO r FROM public.v_job_cost_events WHERE source_id = 'BILL-S1:1';
  IF r.lane <> 'materials' OR r.amount_ex <> 100 OR r.business_unit <> 'SW - FENCING' OR NOT r.paid OR r.paid_on <> '2026-08-15' THEN
    RAISE EXCEPTION 'jp cost: inclusive 305 line wrong: %', row_to_json(r);
  END IF;
  SELECT lane, amount_ex INTO r FROM public.v_job_cost_events WHERE source_id = 'BILL-S1:2';
  IF r.lane <> 'labour' OR r.amount_ex <> 50 THEN RAISE EXCEPTION 'jp cost: 306 line wrong: %', row_to_json(r); END IF;
  SELECT lane, paid INTO r FROM public.v_job_cost_events WHERE source_id = 'BILL-S2:1';
  IF r.lane <> 'commission' OR r.paid THEN RAISE EXCEPTION 'jp cost: commission line wrong: %', row_to_json(r); END IF;

  SELECT party, confidence, match_method INTO r FROM public.v_job_cost_events
   WHERE job_id = 'a7000000-0000-4000-8000-000000000004';
  IF r.party <> 'Trade One' OR r.confidence <> 'medium' OR r.match_method <> 'line_job_number' THEN
    RAISE EXCEPTION 'jp cost: JP-MS line found by job number wrong: %', row_to_json(r);
  END IF;
END $$;

-- ── Revenue events ──────────────────────────────────────────────────────────
DO $$
DECLARE
  r record;
BEGIN
  SELECT
    sum(amount_ex) FILTER (WHERE counts_as_invoiced) AS invoiced,
    count(*) FILTER (WHERE kind = 'variation') AS variations,
    sum(amount_ex) FILTER (WHERE kind = 'variation') AS variation_ex,
    sum(amount_ex) FILTER (WHERE kind = 'variation' AND agreed) AS agreed_variation_ex,
    bool_or(document_id = 'INV-3') AS has_voided
  INTO r
  FROM public.v_job_revenue_events
  WHERE job_id = 'a7000000-0000-4000-8000-000000000001';
  IF r.invoiced <> 1000 THEN RAISE EXCEPTION 'jp revenue: JP-FENCE invoiced %, expected 1000', r.invoiced; END IF;
  IF r.variations <> 9 OR r.variation_ex <> 718 OR r.agreed_variation_ex <> 288 THEN
    RAISE EXCEPTION 'jp revenue: variation list/agreement wrong: listed % amount % agreed %', r.variations, r.variation_ex, r.agreed_variation_ex;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.v_job_revenue_events
    WHERE job_id = 'a7000000-0000-4000-8000-000000000001'
      AND kind = 'variation'
      AND document_number IN ('V1', 'V5', 'V6', 'V7', 'V8', 'V9')
      AND agreed
  ) THEN RAISE EXCEPTION 'jp revenue: approved-only, sent, declined, rejected or pending variation counted as agreed'; END IF;
  IF r.has_voided THEN RAISE EXCEPTION 'jp revenue: voided invoice listed'; END IF;
  IF (SELECT amount_ex FROM public.v_job_revenue_events WHERE document_id = 'INV-4') <> 1500 THEN
    RAISE EXCEPTION 'jp revenue: header fallback for an invoice with no lines';
  END IF;
END $$;

-- ── Job profit rows ─────────────────────────────────────────────────────────
DO $$
DECLARE
  r record;
BEGIN
  IF EXISTS (SELECT 1 FROM public.v_job_profit WHERE job_number = 'JP-OLD') THEN
    RAISE EXCEPTION 'jp profit: legacy job is in the engine';
  END IF;

  -- JP-FENCE: line level, every lane, frozen expected, sent quote value.
  SELECT * INTO r FROM public.job_profit('a7000000-0000-4000-8000-000000000001');
  IF r.cost_basis <> 'line_level' THEN RAISE EXCEPTION 'jp fence: basis %', r.cost_basis; END IF;
  IF (r.actual_labour_ex, r.actual_materials_ex, r.actual_commission_ex, r.actual_other_ex, r.actual_cost_ex)
     IS DISTINCT FROM (350::numeric, 100::numeric, 120::numeric, 0::numeric, 570::numeric) THEN
    RAISE EXCEPTION 'jp fence: lanes % % % % %', r.actual_labour_ex, r.actual_materials_ex, r.actual_commission_ex, r.actual_other_ex, r.actual_cost_ex;
  END IF;
  IF r.invoiced_ex <> 1000 OR r.collected_ex <> 1000 OR r.draft_revenue_ex <> 50 OR r.variations_listed_ex <> 288 THEN
    RAISE EXCEPTION 'jp fence: revenue % % % %', r.invoiced_ex, r.collected_ex, r.draft_revenue_ex, r.variations_listed_ex;
  END IF;
  IF r.profit_ex <> 430 OR r.margin_pct <> 43.0 THEN RAISE EXCEPTION 'jp fence: profit % margin %', r.profit_ex, r.margin_pct; END IF;
  IF r.committed_open_ex <> 80 THEN RAISE EXCEPTION 'jp fence: committed %', r.committed_open_ex; END IF;
  IF NOT r.revenue_verified_paid THEN RAISE EXCEPTION 'jp fence: revenue should be verified paid'; END IF;
  IF r.costs_verified_paid THEN RAISE EXCEPTION 'jp fence: an authorised bill is not verified paid'; END IF;
  IF r.expected_source <> 'frozen_at_acceptance' OR r.expected_cost_ex <> 490 OR r.expected_labour_ex <> 250 THEN
    RAISE EXCEPTION 'jp fence: expected % % %', r.expected_source, r.expected_cost_ex, r.expected_labour_ex;
  END IF;
  IF r.quoted_ex <> 1200 OR r.quoted_source <> 'sent_quote:newest_current:quote_revision' THEN
    RAISE EXCEPTION 'jp fence: quoted % from %', r.quoted_ex, r.quoted_source;
  END IF;
  IF r.revenue_flag <> 'ok' OR r.cost_flag <> 'ok' THEN RAISE EXCEPTION 'jp fence: flags % %', r.revenue_flag, r.cost_flag; END IF;
  IF NOT ('open_purchase_orders' = ANY (r.completeness) AND 'draft_revenue' = ANY (r.completeness)) THEN
    RAISE EXCEPTION 'jp fence: completeness %', r.completeness;
  END IF;

  -- JP-PROJ: project total larger than line level; materials inferred.
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP-PROJ';
  IF r.cost_basis <> 'xero_project_inferred' OR NOT r.materials_inferred THEN RAISE EXCEPTION 'jp proj: basis %', r.cost_basis; END IF;
  IF r.actual_labour_ex <> 300 OR r.actual_materials_ex <> 700 OR r.actual_cost_ex <> 1000 OR r.line_level_cost_ex <> 300 THEN
    RAISE EXCEPTION 'jp proj: lanes % % % %', r.actual_labour_ex, r.actual_materials_ex, r.actual_cost_ex, r.line_level_cost_ex;
  END IF;
  IF r.profit_ex <> 500 OR r.margin_pct <> 33.3 THEN RAISE EXCEPTION 'jp proj: profit % margin %', r.profit_ex, r.margin_pct; END IF;
  IF r.cost_flag <> 'cost_basis_inferred' OR r.costs_verified_paid THEN RAISE EXCEPTION 'jp proj: cost flag %', r.cost_flag; END IF;
  IF r.revenue_verified_paid OR round(r.collected_ex, 2) <> 500 THEN RAISE EXCEPTION 'jp proj: collected %', r.collected_ex; END IF;
  IF r.expected_source <> 'accepted_quote_revision' OR r.expected_materials_ex <> 500 OR r.expected_cost_ex <> 960 THEN
    RAISE EXCEPTION 'jp proj: expected % %', r.expected_source, r.expected_cost_ex;
  END IF;
  IF r.quoted_ex <> 1500 OR r.quoted_source <> 'sent_quote:accepted:quote_revision' THEN
    RAISE EXCEPTION 'jp proj: quoted % from %', r.quoted_ex, r.quoted_source;
  END IF;

  -- JP-DBL: trade lines exceed the project total; never summed with it.
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP-DBL';
  IF r.cost_basis <> 'line_level' OR r.actual_cost_ex <> 260 OR r.actual_materials_ex <> -40 OR NOT ('project_below_trade_lines' = ANY (r.completeness)) THEN
    RAISE EXCEPTION 'jp dbl: basis % cost % completeness %', r.cost_basis, r.actual_cost_ex, r.completeness;
  END IF;
  IF r.xero_project_expenses_ex <> 200 THEN RAISE EXCEPTION 'jp dbl: project figure %', r.xero_project_expenses_ex; END IF;
  IF r.expected_source <> 'live_pricing_estimate' OR r.expected_materials_ex <> 250 OR r.expected_cost_ex <> 500 THEN
    RAISE EXCEPTION 'jp dbl: expected % %', r.expected_source, r.expected_cost_ex;
  END IF;
  IF r.quoted_ex <> 900 OR r.quoted_source <> 'live_price_not_a_sent_quote' THEN
    RAISE EXCEPTION 'jp dbl: quoted % from %', r.quoted_ex, r.quoted_source;
  END IF;
  -- labour-only cost on a fencing job: the margin is not published
  IF NOT ('materials_not_linked' = ANY (r.completeness)) OR r.cost_flag <> 'materials_not_linked'
     OR r.margin_pct IS NOT NULL OR r.profit_ex IS NOT NULL OR r.profit_ex_unsuppressed <> 540 THEN
    RAISE EXCEPTION 'jp dbl: materials suppression % % % %', r.completeness, r.cost_flag, r.margin_pct, r.profit_ex_unsuppressed;
  END IF;
  -- a zero-value pending line neither blocks nor proves payment
  IF NOT r.costs_verified_paid OR 'unapproved_trade_charges' = ANY (r.completeness) THEN
    RAISE EXCEPTION 'jp dbl: zero-value pending line changed paid state: % %', r.costs_verified_paid, r.completeness;
  END IF;

  -- JP-MS: no client invoice, so margin and profit are suppressed.
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP-MS';
  IF r.work_type <> 'makesafe' OR r.work_subtype <> 'roof_report' THEN RAISE EXCEPTION 'jp ms: work type % %', r.work_type, r.work_subtype; END IF;
  IF r.revenue_flag <> 'missing_client_invoice' OR r.margin_pct IS NOT NULL OR r.profit_ex IS NOT NULL THEN
    RAISE EXCEPTION 'jp ms: suppression % % %', r.revenue_flag, r.margin_pct, r.profit_ex;
  END IF;
  IF r.cost_flag <> 'text_matched_lines' OR r.actual_labour_ex <> 120 THEN RAISE EXCEPTION 'jp ms: cost % %', r.cost_flag, r.actual_labour_ex; END IF;
  IF r.quoted_ex IS NOT NULL OR r.expected_source IS NOT NULL THEN RAISE EXCEPTION 'jp ms: quoted or expected invented'; END IF;
END $$;

ROLLBACK;
