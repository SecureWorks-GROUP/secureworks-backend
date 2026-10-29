-- Contract for 20261009130000_job_profit_engine (job profitability PR 1).
--
-- Synthetic jobs, fixed dates, no customer data. Everything rolls back.
--   JP-FENCE  two projects linked by contact only (no job number, and a longer
--             number): no project figure, flagged.
--             Line-level costs from every source, the exclusions (ops-rejected
--             and Xero-deleted trade invoices, QA test line, trade-mirror bills
--             by id and by the app's line format, a deleted bill), inclusive
--             GST lines, a draft and a voided sales invoice, all variation
--             states with only agreed values summed, an open PO, frozen
--             expected costs and a sent quote.
--   JP-PROJ   Xero Project total larger than line-level: the total is evidence
--             only, actual cost stays line-level, profit and margin unknown;
--             a second project linked by contact only adds nothing and flags
--             the job.
--   JP-INF    project expenses 5000, trade labour 3000 not on the project:
--             cost 3000 line-level, the 5000 never a cost, no profit figure.
--   JP-DBL    trade lines larger than the project total: never summed with
--             it, a negative materials deduction cannot publish a labour-only
--             margin, and a live price and live pricing estimate are never a
--             quoted figure or an expected cost.
--   JP-LIVE   no quote sent: quoted and expected stay null whatever the live
--             price says, and a live materials estimate still holds back a
--             labour-only margin.
--   JP-QQ     a quick quote sent with no cost figures (zeros stored): quoted
--             is the sent value, expected cost is null, never 0.
--   JP-QQ2    an accepted quote with no cost figures over an earlier,
--             superseded version that had them: expected cost is null; the
--             older version never stands in.
--   JP-SENT   a sent, unaccepted quote whose newest revision carries costs:
--             those are the expected cost, source sent_quote_revision.
--   JP-MS     make-safe roof report with no client invoice and a trade line
--             found by job number: margin suppressed, flags carried.
--   JP-REP    a fencing card family-tagged repair, invoiced with a materials
--             bill and no labour: reports as repair, margin suppressed.
--   JP-REST   an insurance card whose restoration type outranks a stale
--             make-safe family.
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
   '2026-08-01T00:00:00Z'),
  ('a7000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'JP-REP', false,
   '{"makesafe_job_family": "repair"}', NULL, NULL, '2026-08-01T00:00:00Z'),
  ('a7000000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000001', 'complete', 'insurance', 'JP-REST', false,
   '{"insurance_job_type": "restoration", "makesafe_job_family": "make_safe"}', NULL, NULL, '2026-08-01T00:00:00Z'),
  ('a7000000-0000-4000-8000-000000000008', '00000000-0000-0000-0000-000000000001', 'complete', 'makesafe', 'JP-INF', false, '{}', NULL, NULL,
   '2026-08-01T00:00:00Z'),
  ('a7000000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000001', 'complete', 'makesafe', 'JP-LIVE', false, '{}',
   '{"totalExGST": 5000, "totalCostEstimate": 900, "labourCostEstimate": 500, "materialCostEstimate": 400}', NULL,
   '2026-08-01T00:00:00Z'),
  ('a7000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000001', 'quoted', 'makesafe', 'JP-QQ', false, '{}', NULL, NULL,
   '2026-08-01T00:00:00Z'),
  ('a7000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000001', 'accepted', 'makesafe', 'JP-QQ2', false, '{}', NULL, NULL,
   '2026-08-01T00:00:00Z'),
  ('a7000000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000001', 'quoted', 'makesafe', 'JP-SENT', false, '{}', NULL, NULL,
   '2026-08-01T00:00:00Z');

INSERT INTO public.users (id, org_id, name) VALUES
  ('a7100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'Trade One');

-- Trade invoices carry the 2026-09-18 money split (gst off, 12% super,
-- 6% withheld). T1 paid, T2 ops-rejected, T3 Xero bill deleted, T4 a QA test
-- line, T5 approved and pushed, not yet paid, T6 paid (its subtotal is net of
-- its -40 materials deduction line, so its lines are complete), T7 a trade's
-- empty day still awaiting acknowledgment (zero value), T8 and T9 paid.
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
  ('a7200000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000001', 'a7100000-0000-4000-8000-000000000001', '2026-08-03', 'paid', 260, 'BILL-T6', 'PAID', 'SW-INV-T6', '2026-08-25',
   false, 0, 260, 0.12, 31.2, 260, 244.4),
  ('a7200000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000001', 'a7100000-0000-4000-8000-000000000001', '2026-08-03', 'pending_acknowledgment', 0, NULL, NULL, 'SW-INV-T7', NULL,
   false, 0, 0, 0.12, 0, 0, 0),
  ('a7200000-0000-4000-8000-000000000008', '00000000-0000-0000-0000-000000000001', 'a7100000-0000-4000-8000-000000000001', '2026-08-03', 'paid', 3000, 'BILL-T8', 'PAID', 'SW-INV-T8', '2026-08-25',
   false, 0, 3000, 0.12, 360, 3000, 2820),
  ('a7200000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000001', 'a7100000-0000-4000-8000-000000000001', '2026-08-03', 'paid', 500, 'BILL-T9', 'PAID', 'SW-INV-T9', '2026-08-25',
   false, 0, 500, 0.12, 60, 500, 470);

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
  ('a7200000-0000-4000-8000-000000000005', NULL, 'JP-MS', 'make safe', 'Roof report attendance', 120, 2, '2026-08-06'),
  ('a7200000-0000-4000-8000-000000000008', 'a7000000-0000-4000-8000-000000000008', NULL, 'labour', 'Site labour', 3000, 40, '2026-08-05'),
  ('a7200000-0000-4000-8000-000000000009', 'a7000000-0000-4000-8000-000000000009', NULL, 'labour', 'Site labour', 500, 8, '2026-08-05');

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
   'a7000000-0000-4000-8000-000000000003', NULL, '[{"LineAmount": 800, "AccountCode": "200", "Description": "Fence"}]'),
  -- JP-REP: invoiced, a materials bill, no labour linked
  ('00000000-0000-0000-0000-000000000001', 'INV-6', 'INV-6', 'ACCREC', 'PAID', 'Client', 10000, 11000, 11000, '2026-08-08', '2026-08-28',
   'a7000000-0000-4000-8000-000000000006', NULL, '[{"LineAmount": 10000, "AccountCode": "200", "Description": "Repair"}]'),
  ('00000000-0000-0000-0000-000000000001', 'BILL-S4', 'S-4', 'ACCPAY', 'PAID', 'Fence Supplies', 3000, 3300, 3300, '2026-08-02', '2026-08-15',
   'a7000000-0000-4000-8000-000000000006', NULL, '[{"LineAmount": 3000, "AccountCode": "305", "Description": "Panels"}]'),
  -- JP-INF and JP-LIVE: invoiced and paid
  ('00000000-0000-0000-0000-000000000001', 'INV-7', 'INV-7', 'ACCREC', 'PAID', 'Client', 10000, 11000, 11000, '2026-08-08', '2026-08-28',
   'a7000000-0000-4000-8000-000000000008', NULL, '[{"LineAmount": 10000, "AccountCode": "200", "Description": "Works"}]'),
  ('00000000-0000-0000-0000-000000000001', 'INV-8', 'INV-8', 'ACCREC', 'PAID', 'Client', 2000, 2200, 2200, '2026-08-08', '2026-08-28',
   'a7000000-0000-4000-8000-000000000009', NULL, '[{"LineAmount": 2000, "AccountCode": "200", "Description": "Works"}]');

INSERT INTO public.xero_projects (job_id, project_name, total_expenses, total_invoiced) VALUES
  ('a7000000-0000-4000-8000-000000000002', 'jp-proj 4 Patio Pl', 1000, 1500),
  ('a7000000-0000-4000-8000-000000000003', 'JP-DBL 6 Fence Rd', 200, 800),
  -- supplier bills only; the trade app's labour bill is not on the project
  ('a7000000-0000-4000-8000-000000000008', 'JP-INF 9 Sample St', 5000, 10000),
  -- linked by contact only: another job's project, and a longer job number
  ('a7000000-0000-4000-8000-000000000002', 'SW1334 old patio', 9000, 9500),
  ('a7000000-0000-4000-8000-000000000001', 'SW1334 old patio', 9000, 9500),
  ('a7000000-0000-4000-8000-000000000001', 'JP-FENCE77 other site', 500, 600);

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
-- The agreed ones (2, 3, 4) carry a cost figure: TP-13 (20261029160000) names
-- an agreed variation with none variation_not_costed and holds the margin.
-- job_variations.cost_estimate is production's column (20260322000010); the
-- TP-13 case's setup adds it to this stub before any contract runs.
UPDATE public.job_variations SET cost_estimate = 10
WHERE job_id = 'a7000000-0000-4000-8000-000000000001' AND variation_number IN (2, 3, 4);

-- PO-OPEN is dated two days before the run: an open order inside TP-13's 30
-- days (20261029160000), so the job still publishes a margin with the order
-- named open_purchase_orders. An older open order holds the margin.
INSERT INTO public.purchase_orders (job_id, po_number, supplier_name, status, subtotal, total, created_at) VALUES
  ('a7000000-0000-4000-8000-000000000001', 'PO-OPEN', 'Fence Supplies', 'sent', 80, 88, now() - interval '2 days'),
  ('a7000000-0000-4000-8000-000000000001', 'PO-DRAFT', 'Fence Supplies', 'draft', 500, 550, '2026-08-01T00:00:00Z');

-- PO-BILLED: its bill BILL-S1 landed as a materials fact matched to the PO;
-- the PO itself was never stamped, and it is no longer open.
-- BILL-S1 and BILL-S2 carry installer-account (306) lines, so under JP-12
-- (20261020181800) they count only once a person placed them: both facts
-- are a person's placement from Bills to place (automation_source manual_queue).
INSERT INTO public.purchase_orders (id, job_id, po_number, supplier_name, status, subtotal, total, created_at) VALUES
  ('a7400000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', 'PO-BILLED', 'Fence Supplies', 'sent', 100, 110, '2026-08-01T00:00:00Z');
INSERT INTO public.job_materials_facts (job_id, xero_invoice_id, invoice_number, contact_name, lane, kind, amount_ex_gst, confidence, fact_date, matched_po_id, automation_source) VALUES
  ('a7000000-0000-4000-8000-000000000001', 'BILL-S1', 'S-1', 'Fence Supplies', 'materials', 'actual', 100, 'high', '2026-08-02', 'a7400000-0000-4000-8000-000000000001', 'manual_queue'),
  ('a7000000-0000-4000-8000-000000000001', 'BILL-S2', 'S-2', 'Sales Agent', 'commission', 'actual', 20, 'high', '2026-08-12', NULL, 'manual_queue');

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

-- JP-QQ: a quick quote sent with no cost figures; the adapter stores zeros.
INSERT INTO public.job_documents (id, job_id, type, sent_at, created_at) VALUES
  ('a7300000-0000-4000-8000-000000000003', 'a7000000-0000-4000-8000-00000000000a', 'quote', '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z');
INSERT INTO public.quote_revisions (job_id, job_document_id, version, sent_at, released_via, totals_snapshot_json, internal_cost_snapshot_json) VALUES
  ('a7000000-0000-4000-8000-00000000000a', 'a7300000-0000-4000-8000-000000000003', 1, '2026-07-20T00:00:00Z', 'send-quote/send',
   '{"total_inc_gst": 550, "total_ex_gst": 500}',
   '{"cost_estimates": {"labour_total": 0, "material_total": 0, "subcontract_commission_total": 0}}');

-- JP-QQ2: version 1 sent at 800 with costs 350 and superseded, then version 2
-- sent at 900 and accepted, its costs all zero.
INSERT INTO public.job_documents (id, job_id, type, sent_at, superseded_at, created_at) VALUES
  ('a7300000-0000-4000-8000-000000000004', 'a7000000-0000-4000-8000-00000000000b', 'quote', '2026-07-18T00:00:00Z', '2026-07-20T00:00:00Z', '2026-07-18T00:00:00Z');
INSERT INTO public.job_documents (id, job_id, type, sent_at, accepted_at, created_at) VALUES
  ('a7300000-0000-4000-8000-000000000005', 'a7000000-0000-4000-8000-00000000000b', 'quote', '2026-07-20T00:00:00Z', '2026-07-22T00:00:00Z', '2026-07-20T00:00:00Z');
INSERT INTO public.quote_revisions (job_id, job_document_id, version, sent_at, released_via, totals_snapshot_json, internal_cost_snapshot_json) VALUES
  ('a7000000-0000-4000-8000-00000000000b', 'a7300000-0000-4000-8000-000000000004', 1, '2026-07-18T00:00:00Z', 'send-quote/send',
   '{"total_inc_gst": 880, "total_ex_gst": 800}',
   '{"cost_estimates": {"labour_total": 200, "material_total": "150", "subcontract_commission_total": 0}}'),
  ('a7000000-0000-4000-8000-00000000000b', 'a7300000-0000-4000-8000-000000000005', 2, '2026-07-20T00:00:00Z', 'send-quote/send',
   '{"total_inc_gst": 990, "total_ex_gst": 900}',
   '{"cost_estimates": {"labour_total": 0, "material_total": 0, "subcontract_commission_total": 0}}');

-- JP-SENT: sent at 1100 inc GST, not accepted, its newest revision costed.
INSERT INTO public.job_documents (id, job_id, type, sent_at, created_at) VALUES
  ('a7300000-0000-4000-8000-000000000006', 'a7000000-0000-4000-8000-00000000000c', 'quote', '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z');
INSERT INTO public.quote_revisions (job_id, job_document_id, version, sent_at, released_via, totals_snapshot_json, internal_cost_snapshot_json) VALUES
  ('a7000000-0000-4000-8000-00000000000c', 'a7300000-0000-4000-8000-000000000006', 1, '2026-07-19T00:00:00Z', 'send-quote/send',
   '{"total_inc_gst": 880, "total_ex_gst": 800}',
   '{"cost_estimates": {"labour_total": 100, "material_total": 100, "subcontract_commission_total": 100}}'),
  ('a7000000-0000-4000-8000-00000000000c', 'a7300000-0000-4000-8000-000000000006', 2, '2026-07-20T00:00:00Z', 'send-quote/send',
   '{"total_inc_gst": 1100, "total_ex_gst": 1000}',
   '{"cost_estimates": {"labour_total": 300, "material_total": "250", "subcontract_commission_total": 40}}');

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
  IF r.po_n <> 1 THEN RAISE EXCEPTION 'jp cost: JP-FENCE open POs %, expected 1 (draft and billed excluded)', r.po_n; END IF;
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
  IF r.variations <> 9 OR r.variation_ex <> 818 OR r.agreed_variation_ex <> 288 THEN
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
  IF r.cost_basis <> 'line_level' OR r.line_level_cost_ex <> r.actual_cost_ex THEN
    RAISE EXCEPTION 'jp fence: basis % line level %', r.cost_basis, r.line_level_cost_ex;
  END IF;
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
  -- projects linked by contact only: no figure, flagged
  IF r.xero_project_expenses_ex IS NOT NULL OR r.xero_project_invoiced_ex IS NOT NULL OR r.xero_project_count <> 0 THEN
    RAISE EXCEPTION 'jp fence: contact-linked project figure % % %', r.xero_project_expenses_ex, r.xero_project_invoiced_ex, r.xero_project_count;
  END IF;
  IF NOT ('xero_project_linked_by_contact_only' = ANY (r.completeness)) THEN
    RAISE EXCEPTION 'jp fence: contact-linked project not flagged %', r.completeness;
  END IF;

  -- JP-PROJ: project total larger than line level. The total is evidence only:
  -- actual cost stays line-level, no lane is inferred, no profit is published.
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP-PROJ';
  IF r.cost_basis <> 'line_level' THEN RAISE EXCEPTION 'jp proj: basis %', r.cost_basis; END IF;
  IF r.actual_labour_ex <> 300 OR r.actual_materials_ex <> 0 OR r.actual_cost_ex <> 300 OR r.line_level_cost_ex <> 300 THEN
    RAISE EXCEPTION 'jp proj: lanes % % % %', r.actual_labour_ex, r.actual_materials_ex, r.actual_cost_ex, r.line_level_cost_ex;
  END IF;
  IF r.profit_ex IS NOT NULL OR r.margin_pct IS NOT NULL OR r.profit_ex_unsuppressed IS NOT NULL THEN
    RAISE EXCEPTION 'jp proj: profit % margin % unsuppressed %', r.profit_ex, r.margin_pct, r.profit_ex_unsuppressed;
  END IF;
  IF r.cost_flag <> 'xero_project_exceeds_line_costs' OR r.costs_verified_paid
     OR NOT ('xero_project_exceeds_line_costs' = ANY (r.completeness)) OR NOT ('materials_not_linked' = ANY (r.completeness)) THEN
    RAISE EXCEPTION 'jp proj: cost flag % completeness %', r.cost_flag, r.completeness;
  END IF;
  -- only the project named after the job counts; the contact-linked 9000 does not
  IF r.xero_project_expenses_ex <> 1000 OR r.xero_project_invoiced_ex <> 1500 OR r.xero_project_count <> 1
     OR NOT ('xero_project_linked_by_contact_only' = ANY (r.completeness)) THEN
    RAISE EXCEPTION 'jp proj: project figure % % % completeness %', r.xero_project_expenses_ex, r.xero_project_invoiced_ex, r.xero_project_count, r.completeness;
  END IF;
  IF r.revenue_verified_paid OR round(r.collected_ex, 2) <> 500 THEN RAISE EXCEPTION 'jp proj: collected %', r.collected_ex; END IF;
  IF r.expected_source <> 'accepted_quote_revision' OR r.expected_materials_ex <> 500 OR r.expected_cost_ex <> 960 THEN
    RAISE EXCEPTION 'jp proj: expected % %', r.expected_source, r.expected_cost_ex;
  END IF;
  IF r.quoted_ex <> 1500 OR r.quoted_source <> 'sent_quote:accepted:quote_revision' THEN
    RAISE EXCEPTION 'jp proj: quoted % from %', r.quoted_ex, r.quoted_source;
  END IF;

  -- JP-INF: project expenses 5000 (supplier bills only), trade labour 3000 not
  -- on the project. Real cost is unknown, so nothing is published as profit and
  -- the 5000 is never a cost.
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP-INF';
  IF r.xero_project_expenses_ex <> 5000 OR r.xero_project_count <> 1 THEN
    RAISE EXCEPTION 'jp inf: project evidence % %', r.xero_project_expenses_ex, r.xero_project_count;
  END IF;
  IF (r.actual_labour_ex, r.actual_materials_ex, r.actual_commission_ex, r.actual_other_ex, r.actual_cost_ex, r.line_level_cost_ex)
     IS DISTINCT FROM (3000::numeric, 0::numeric, 0::numeric, 0::numeric, 3000::numeric, 3000::numeric) THEN
    RAISE EXCEPTION 'jp inf: lanes % % % % % %', r.actual_labour_ex, r.actual_materials_ex, r.actual_commission_ex, r.actual_other_ex, r.actual_cost_ex, r.line_level_cost_ex;
  END IF;
  IF r.invoiced_ex <> 10000 OR r.profit_ex IS NOT NULL OR r.margin_pct IS NOT NULL OR r.profit_ex_unsuppressed IS NOT NULL OR r.margin_ok THEN
    RAISE EXCEPTION 'jp inf: a profit figure was published: % % % %', r.profit_ex, r.margin_pct, r.profit_ex_unsuppressed, r.margin_ok;
  END IF;
  IF r.cost_flag <> 'xero_project_exceeds_line_costs' OR NOT ('xero_project_exceeds_line_costs' = ANY (r.completeness)) THEN
    RAISE EXCEPTION 'jp inf: reason not named: % %', r.cost_flag, r.completeness;
  END IF;
  IF r.costs_verified_paid THEN RAISE EXCEPTION 'jp inf: costs verified paid with project expenses unlinked'; END IF;

  -- JP-DBL: trade lines exceed the project total; never summed with it.
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP-DBL';
  IF r.cost_basis <> 'line_level' OR r.actual_cost_ex <> 260 OR r.actual_materials_ex <> -40 THEN
    RAISE EXCEPTION 'jp dbl: basis % cost % materials %', r.cost_basis, r.actual_cost_ex, r.actual_materials_ex;
  END IF;
  IF r.xero_project_expenses_ex <> 200 OR 'xero_project_linked_by_contact_only' = ANY (r.completeness) THEN
    RAISE EXCEPTION 'jp dbl: project figure % completeness %', r.xero_project_expenses_ex, r.completeness;
  END IF;
  -- no quote sent: the live price 900 and live estimate 500 are never returned
  IF r.expected_source IS NOT NULL OR r.expected_cost_ex IS NOT NULL OR r.expected_labour_ex IS NOT NULL
     OR r.expected_materials_ex IS NOT NULL OR r.expected_commission_ex IS NOT NULL THEN
    RAISE EXCEPTION 'jp dbl: live estimate presented as expected cost % %', r.expected_source, r.expected_cost_ex;
  END IF;
  IF r.quoted_ex IS NOT NULL OR r.quoted_source IS NOT NULL THEN
    RAISE EXCEPTION 'jp dbl: live price presented as quoted % from %', r.quoted_ex, r.quoted_source;
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

  -- JP-LIVE: a make-safe, no quote sent. Quoted and expected stay null, and the
  -- live materials estimate still holds back a labour-only margin.
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP-LIVE';
  IF r.quoted_ex IS NOT NULL OR r.quoted_source IS NOT NULL OR r.expected_source IS NOT NULL OR r.expected_cost_ex IS NOT NULL
     OR r.expected_materials_ex IS NOT NULL THEN
    RAISE EXCEPTION 'jp live: live figure returned % % % %', r.quoted_ex, r.quoted_source, r.expected_source, r.expected_cost_ex;
  END IF;
  IF r.actual_cost_ex <> 500 OR r.cost_flag <> 'materials_not_linked' OR r.profit_ex IS NOT NULL OR r.margin_pct IS NOT NULL
     OR r.profit_ex_unsuppressed <> 1500 THEN
    RAISE EXCEPTION 'jp live: materials suppression % % % % %', r.actual_cost_ex, r.cost_flag, r.profit_ex, r.margin_pct, r.profit_ex_unsuppressed;
  END IF;

  -- JP-QQ: sent with no cost figures. The quote is real, the expected cost is
  -- unknown: null in every lane, never 0.
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP-QQ';
  IF r.quoted_ex <> 500 OR r.quoted_source <> 'sent_quote:newest_current:quote_revision' THEN
    RAISE EXCEPTION 'jp qq: quoted % from %', r.quoted_ex, r.quoted_source;
  END IF;
  IF r.expected_source IS NOT NULL OR r.expected_cost_ex IS NOT NULL OR r.expected_labour_ex IS NOT NULL
     OR r.expected_materials_ex IS NOT NULL OR r.expected_commission_ex IS NOT NULL THEN
    RAISE EXCEPTION 'jp qq: zero-filled revision read as a fixed cost % % % % %', r.expected_source, r.expected_cost_ex,
      r.expected_labour_ex, r.expected_materials_ex, r.expected_commission_ex;
  END IF;

  -- JP-QQ2: the accepted revision is also the newest sent one and fixed no
  -- cost. The superseded version's 350 never stands in for it.
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP-QQ2';
  IF r.quoted_ex <> 900 OR r.quoted_source <> 'sent_quote:accepted:quote_revision' THEN
    RAISE EXCEPTION 'jp qq2: quoted % from %', r.quoted_ex, r.quoted_source;
  END IF;
  IF r.expected_source IS NOT NULL OR r.expected_cost_ex IS NOT NULL OR r.expected_labour_ex IS NOT NULL
     OR r.expected_materials_ex IS NOT NULL OR r.expected_commission_ex IS NOT NULL THEN
    RAISE EXCEPTION 'jp qq2: an older quote version stood in as expected cost % % % % %', r.expected_source, r.expected_cost_ex,
      r.expected_labour_ex, r.expected_materials_ex, r.expected_commission_ex;
  END IF;

  -- JP-SENT: sent, not accepted. The newest sent revision's costs are the
  -- expected cost.
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP-SENT';
  IF r.expected_source IS DISTINCT FROM 'sent_quote_revision'
     OR (r.expected_labour_ex, r.expected_materials_ex, r.expected_commission_ex, r.expected_cost_ex)
        IS DISTINCT FROM (300::numeric, 250::numeric, 40::numeric, 590::numeric) THEN
    RAISE EXCEPTION 'jp sent: expected % % % % %', r.expected_source, r.expected_labour_ex, r.expected_materials_ex,
      r.expected_commission_ex, r.expected_cost_ex;
  END IF;

  -- JP-MS: no client invoice, so margin and profit are suppressed.
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP-MS';
  IF r.work_type <> 'makesafe' OR r.work_subtype <> 'roof_report' THEN RAISE EXCEPTION 'jp ms: work type % %', r.work_type, r.work_subtype; END IF;
  IF r.revenue_flag <> 'missing_client_invoice' OR r.margin_pct IS NOT NULL OR r.profit_ex IS NOT NULL THEN
    RAISE EXCEPTION 'jp ms: suppression % % %', r.revenue_flag, r.margin_pct, r.profit_ex;
  END IF;
  IF r.cost_flag <> 'text_matched_lines' OR r.actual_labour_ex <> 120 THEN RAISE EXCEPTION 'jp ms: cost % %', r.cost_flag, r.actual_labour_ex; END IF;
  IF r.quoted_ex IS NOT NULL OR r.expected_source IS NOT NULL THEN RAISE EXCEPTION 'jp ms: quoted or expected invented'; END IF;

  -- JP-REP: family repair outranks jobs.type fencing; no labour, no margin.
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP-REP';
  IF r.work_type <> 'repair' OR r.work_subtype <> 'repair' THEN RAISE EXCEPTION 'jp rep: work type % %', r.work_type, r.work_subtype; END IF;
  IF r.cost_flag <> 'no_labour_linked' OR r.margin_pct IS NOT NULL OR r.profit_ex IS NOT NULL OR r.profit_ex_unsuppressed <> 7000 THEN
    RAISE EXCEPTION 'jp rep: labour suppression % % % %', r.cost_flag, r.margin_pct, r.profit_ex, r.profit_ex_unsuppressed;
  END IF;

  -- JP-REST: restoration type outranks a stale make-safe family.
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JP-REST';
  IF r.work_type <> 'insurance' OR r.work_subtype <> 'restoration' THEN RAISE EXCEPTION 'jp rest: work type % %', r.work_type, r.work_subtype; END IF;
END $$;

ROLLBACK;
