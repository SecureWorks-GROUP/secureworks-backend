-- Contract for 20261104200500 (Job Profit, finish-line row A2).
--   1. job_profit_line_evidence_many (rule r57-v4): a credit applied in Xero to a customer invoice follows its
--      invoice: evidenced when every line with money on that invoice is evidenced to the job; it counts with revenue,
--      never with cost. Shaped on SW1346 (CN-1365 on INV-1075) and SWF-26813 (CN-1548 on INV-1466).
--   2. v_job_profit: the Xero project check compares the project with the cost lines before supplier credits (a
--      Xero project holds a credited bill at its full amount). Shaped on SWF-26614 and SWF-26831. Actual cost still
--      nets the credit.
-- Synthetic rows only; every expected figure is worked out here by hand. Everything rolls back.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout = '60s';
SET LOCAL TimeZone = 'UTC';

-- 1. The evidence rule on exact rows: its inputs are views built from the whole engine, so inside this transaction
--    each is renamed aside and a table with its columns stands in (the 20261104093000 contract does the same).
ALTER VIEW public.v_job_cost_events RENAME TO v_job_cost_events_a2n_aside;
ALTER VIEW public.v_job_profit RENAME TO v_job_profit_a2n_aside;
ALTER VIEW public.v_job_revenue_events RENAME TO v_job_revenue_events_a2n_aside;
ALTER VIEW public.v_bookkeeping_line_parts_current RENAME TO v_bookkeeping_line_parts_current_a2n_aside;
ALTER TABLE public.trade_invoice_lines RENAME TO trade_invoice_lines_a2n_aside;
ALTER TABLE public.trade_invoices RENAME TO trade_invoices_a2n_aside;
ALTER TABLE public.v_xero_lines RENAME TO v_xero_lines_a2n_aside;
ALTER TABLE public.v_bookkeeping_line_evidence_current RENAME TO v_bookkeeping_line_evidence_current_a2n_aside;

CREATE TABLE public.v_job_cost_events (job_id uuid, source text, source_id text, document_id text, document_number text,
  description text, amount_ex numeric, event_date date, lane text, is_actual boolean);
CREATE TABLE public.v_job_profit (job_id uuid, margin_ok boolean, cost_flag text, invoiced_ex numeric, actual_cost_ex numeric);
CREATE TABLE public.v_job_revenue_events (job_id uuid, kind text, invoice_date date, amount_ex numeric, status text, paid boolean,
  paid_on date, counts_as_invoiced boolean, source_id text, document_id text, document_number text, party text,
  description text, account_code text, business_unit text, agreed boolean);
CREATE TABLE public.v_bookkeeping_line_parts_current (xero_invoice_id text, xero_line_item_id text, part smallint, parts smallint,
  line_ex numeric, amount_ex_gst numeric, allocation text, job_number text, job_id uuid, evidenced boolean, basis text,
  outcome text, document_ref text, super_withheld boolean, revision text, stream text, emitted_at timestamptz, revision_sha256 text);
CREATE TABLE public.trade_invoices (id uuid, xero_bill_id text);
CREATE TABLE public.trade_invoice_lines (id uuid, trade_invoice_id uuid);
CREATE TABLE public.v_xero_lines (xero_invoice_id text, invoice_type text, invoice_number text, status text, invoice_job_id uuid,
  invoice_date date, contact_name text, n bigint, line_item_id text, description text, account_code text, division text,
  line_ex numeric, cost_source_id text);
CREATE TABLE public.v_bookkeeping_line_evidence_current (xero_invoice_id text, xero_line_item_id text, amount_ex_gst numeric,
  allocation text, job_number text, job_id uuid, evidenced boolean, basis text, outcome text, document_ref text,
  trade_invoice_line_id uuid, revision text, stream text, emitted_at timestamptz, revision_sha256 text);

-- Job CA: its invoice's one line (1,000.00) evidenced to it; a credit note of 100.00 ex GST applied in Xero (SW1346).
-- Job CB: its invoice's line has no evidence; a credit of 50.00 applied to it.
-- Job CC: its invoice has one line evidenced to it and one Bookkeeping places on job CD; a credit of 20.00 applied.
INSERT INTO public.v_xero_lines VALUES
  ('INVCA', 'ACCREC', 'INV-CA', 'PAID', 'a2ca0000-0000-0000-0000-000000000001', '2026-08-03', 'Client A', 1, 'CA1', 'Patio', '208', 'patios', 1000, 'INVCA:1'),
  ('INVCB', 'ACCREC', 'INV-CB', 'PAID', 'a2cb0000-0000-0000-0000-000000000002', '2026-08-03', 'Client B', 1, 'CB1', 'Fence', '207', 'fencing', 500, 'INVCB:1'),
  ('INVCC', 'ACCREC', 'INV-CC', 'PAID', 'a2cc0000-0000-0000-0000-000000000003', '2026-08-03', 'Client C', 1, 'CC1', 'Fence', '207', 'fencing', 300, 'INVCC:1'),
  ('INVCC', 'ACCREC', 'INV-CC', 'PAID', 'a2cc0000-0000-0000-0000-000000000003', '2026-08-03', 'Client C', 2, 'CC2', 'Gate for job CD', '207', 'fencing', 200, 'INVCC:2');
INSERT INTO public.v_bookkeeping_line_evidence_current (xero_invoice_id, xero_line_item_id, amount_ex_gst, allocation, job_number, job_id, evidenced, revision) VALUES
  ('INVCA', 'CA1', 1000, 'job', 'A2N-CA', 'a2ca0000-0000-0000-0000-000000000001', true, 'r1'),
  ('INVCC', 'CC1', 300, 'job', 'A2N-CC', 'a2cc0000-0000-0000-0000-000000000003', true, 'r1'),
  ('INVCC', 'CC2', 200, 'job', 'A2N-CD', 'a2cd0000-0000-0000-0000-000000000004', true, 'r1');
INSERT INTO public.v_job_revenue_events (job_id, kind, invoice_date, amount_ex, status, counts_as_invoiced, source_id, document_id, document_number, description) VALUES
  ('a2ca0000-0000-0000-0000-000000000001', 'invoice_line', '2026-08-03', 1000, 'PAID', true, 'INVCA:1', 'INVCA', 'INV-CA', 'Patio'),
  ('a2ca0000-0000-0000-0000-000000000001', 'credit_applied', '2026-08-03', -100, 'PAID', true, 'INVCA:credit', 'INVCA', 'INV-CA', 'Credit applied in Xero'),
  ('a2cb0000-0000-0000-0000-000000000002', 'credit_applied', '2026-08-03', -50, 'PAID', true, 'INVCB:credit', 'INVCB', 'INV-CB', 'Credit applied in Xero'),
  ('a2cc0000-0000-0000-0000-000000000003', 'credit_applied', '2026-08-03', -20, 'PAID', true, 'INVCC:credit', 'INVCC', 'INV-CC', 'Credit applied in Xero');
-- Job Profit nets each credit from revenue: CA 1,000.00 - 100.00 = 900.00, no cost.
INSERT INTO public.v_job_profit VALUES
  ('a2ca0000-0000-0000-0000-000000000001', true, 'ok', 900, 0),
  ('a2cb0000-0000-0000-0000-000000000002', true, 'ok', 450, 0),
  ('a2cc0000-0000-0000-0000-000000000003', true, 'ok', 480, 0);

DO $$
DECLARE a jsonb; b jsonb; c jsonb; s jsonb; l jsonb;
BEGIN
  SELECT m.result INTO a FROM public.job_profit_line_evidence_many(ARRAY['a2ca0000-0000-0000-0000-000000000001']::uuid[]) m;
  SELECT m.result INTO b FROM public.job_profit_line_evidence_many(ARRAY['a2cb0000-0000-0000-0000-000000000002']::uuid[]) m;
  SELECT m.result INTO c FROM public.job_profit_line_evidence_many(ARRAY['a2cc0000-0000-0000-0000-000000000003']::uuid[]) m;
  IF a ->> 'status' IS DISTINCT FROM 'verified' THEN
    RAISE EXCEPTION 'A2 credits contract: job CA is not Verified: %', a -> 'why_not_verified';
  END IF;
  IF a ->> 'rule' <> 'r57-v4' OR (a ->> 'items')::int <> 2 OR (a ->> 'cost_items')::int <> 0
     OR (a -> 'reconciles' ->> 'revenue_checked')::numeric <> 900 OR (a -> 'reconciles' ->> 'cost_checked')::numeric <> 0 THEN
    RAISE EXCEPTION 'A2 credits contract: job CA rule %, items %, cost items %, revenue checked %, cost checked % (want r57-v4, 2, 0, 900, 0)',
      a ->> 'rule', a ->> 'items', a ->> 'cost_items', a -> 'reconciles' ->> 'revenue_checked', a -> 'reconciles' ->> 'cost_checked';
  END IF;
  SELECT x INTO l FROM jsonb_array_elements(a -> 'lines') x WHERE x ->> 'ref' = 'INVCA:credit';
  IF l ->> 'state' IS DISTINCT FROM 'evidenced' OR l ->> 'basis' IS DISTINCT FROM 'follows its invoice' OR l ->> 'lane' <> 'revenue'
     OR (l ->> 'amount_ex')::numeric <> -100 THEN
    RAISE EXCEPTION 'A2 credits contract: the credit on an evidenced invoice reads %', l;
  END IF;
  SELECT x INTO l FROM jsonb_array_elements(b -> 'lines') x WHERE x ->> 'ref' = 'INVCB:credit';
  IF b ->> 'status' <> 'provisional' OR l ->> 'state' IS DISTINCT FROM 'no_evidence'
     OR NOT (b -> 'why_not_verified') ? '1 credit(s) applied in Xero to an invoice not evidenced to this job' THEN
    RAISE EXCEPTION 'A2 credits contract: a credit on an invoice with no evidence is not named: %', b;
  END IF;
  SELECT x INTO l FROM jsonb_array_elements(c -> 'lines') x WHERE x ->> 'ref' = 'INVCC:credit';
  IF c ->> 'status' <> 'provisional' OR l ->> 'state' IS DISTINCT FROM 'no_evidence' THEN
    RAISE EXCEPTION 'A2 credits contract: a credit follows an invoice with a line Bookkeeping places elsewhere: %', c;
  END IF;
  -- a credit is never cost: Job Profit's cost of job CA stays the checked cost
  UPDATE public.v_job_profit SET actual_cost_ex = -100 WHERE job_id = 'a2ca0000-0000-0000-0000-000000000001';
  SELECT m.result INTO a FROM public.job_profit_line_evidence_many(ARRAY['a2ca0000-0000-0000-0000-000000000001']::uuid[]) m;
  IF a ->> 'status' = 'verified' THEN RAISE EXCEPTION 'A2 credits contract: a customer credit counted as cost'; END IF;
  UPDATE public.v_job_profit SET actual_cost_ex = 0 WHERE job_id = 'a2ca0000-0000-0000-0000-000000000001';
  -- the score counts job CA and labels the rule
  s := public.job_profit_line_evidence_score('2026-07-01', '2026-11-01');
  IF s ->> 'rule' <> 'r57-v4' OR (s ->> 'jobs_verified')::int <> 1 THEN
    RAISE EXCEPTION 'A2 credits contract: score rule %, jobs verified % (want r57-v4, 1)', s ->> 'rule', s ->> 'jobs_verified';
  END IF;
END $$;

DROP TABLE public.v_job_cost_events, public.v_job_profit, public.v_job_revenue_events, public.v_bookkeeping_line_parts_current,
  public.trade_invoices, public.trade_invoice_lines, public.v_xero_lines, public.v_bookkeeping_line_evidence_current;
ALTER VIEW public.v_job_cost_events_a2n_aside RENAME TO v_job_cost_events;
ALTER VIEW public.v_job_profit_a2n_aside RENAME TO v_job_profit;
ALTER VIEW public.v_job_revenue_events_a2n_aside RENAME TO v_job_revenue_events;
ALTER VIEW public.v_bookkeeping_line_parts_current_a2n_aside RENAME TO v_bookkeeping_line_parts_current;
ALTER TABLE public.trade_invoice_lines_a2n_aside RENAME TO trade_invoice_lines;
ALTER TABLE public.trade_invoices_a2n_aside RENAME TO trade_invoices;
ALTER TABLE public.v_xero_lines_a2n_aside RENAME TO v_xero_lines;
ALTER TABLE public.v_bookkeeping_line_evidence_current_a2n_aside RENAME TO v_bookkeeping_line_evidence_current;

-- 2. v_job_profit on the real engine. Each job: a customer invoice of 2,000.00 ex GST and one supplier bill of
--    1,000.00 ex GST (1,100.00 inc) on the job with 110.00 inc GST credited in Xero, so the cost lines read
--    1,000.00 - 100.00 = 900.00 (the bill's ex-GST share of the credit).
--   A2N-P1  Xero project 1,000.00: the project holds the bill before its credit -> no project flag (was flagged:
--           900.00 < 1,000.00 - 10.00)
--   A2N-P2  Xero project 1,200.00: still above the cost lines before credits (1,000.00 < 1,200.00 - 12.00) -> flagged
--   A2N-P3  no credit; Xero project 1,100.00 against 1,000.00 of cost -> flagged, as before
INSERT INTO public.organisations (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'Synthetic org')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.jobs (id, org_id, status, type, job_number, metadata, pricing_json, created_at)
SELECT ('a2d00000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000001', 'complete', 'fencing',
       'A2N-P' || n, '{}', '{}', '2026-06-01T00:00:00Z'
FROM generate_series(1, 3) n;
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total,
                                  invoice_date, job_id, reference, raw_json, line_items)
SELECT '00000000-0000-0000-0000-000000000001', 'a2n-inv-' || n, 'A2N-INV-' || n, 'ACCREC', 'AUTHORISED', 'Synthetic customer',
       2000, 2200, '2026-08-03', ('a2d00000-0000-4000-8000-00000000000' || n)::uuid, 'A2N-P' || n, '{}',
       jsonb_build_array(jsonb_build_object('LineItemID', 'a2n-inv-line-' || n, 'Description', 'Fence', 'LineAmount', 2000, 'AccountCode', '207'))
FROM generate_series(1, 3) n;
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total,
                                  invoice_date, job_id, reference, raw_json, line_items)
SELECT '00000000-0000-0000-0000-000000000001', 'a2n-bill-' || n, 'A2N-BILL-' || n, 'ACCPAY', 'PAID', 'Synthetic supplier',
       1000, 1100, '2026-08-04', ('a2d00000-0000-4000-8000-00000000000' || n)::uuid, NULL,
       CASE WHEN n < 3 THEN '{"AmountCredited": 110, "LineAmountTypes": "Exclusive"}'::jsonb ELSE '{"LineAmountTypes": "Exclusive"}'::jsonb END,
       jsonb_build_array(jsonb_build_object('LineItemID', 'a2n-bill-line-' || n, 'Description', 'Panels', 'LineAmount', 1000,
                                            'TaxAmount', 100, 'AccountCode', '310'))
FROM generate_series(1, 3) n;
INSERT INTO public.xero_projects (job_id, project_name, total_expenses, total_invoiced) VALUES
  ('a2d00000-0000-4000-8000-000000000001', 'A2N-P1 1 Credit St', 1000, 2000),
  ('a2d00000-0000-4000-8000-000000000002', 'A2N-P2 2 Credit St', 1200, 2000),
  ('a2d00000-0000-4000-8000-000000000003', 'A2N-P3 3 Credit St', 1100, 2000);

DO $$
DECLARE r record; want_cost numeric;
BEGIN
  FOR r IN SELECT p.job_number, p.actual_cost_ex, p.invoiced_ex, p.cost_flag, p.profit_ex_unsuppressed, p.xero_project_expenses_ex
           FROM public.v_job_profit p WHERE p.job_number LIKE 'A2N-P%' ORDER BY p.job_number LOOP
    -- actual cost still nets the credit: only the project check reads the cost lines before credits
    want_cost := CASE WHEN r.job_number = 'A2N-P3' THEN 1000 ELSE 900 END;
    IF r.invoiced_ex <> 2000 OR r.actual_cost_ex <> want_cost THEN
      RAISE EXCEPTION 'A2 credits contract: % reads invoiced %, actual cost % (want 2000 and %)', r.job_number, r.invoiced_ex,
        r.actual_cost_ex, want_cost;
    END IF;
    IF r.job_number = 'A2N-P1' AND (r.cost_flag = 'xero_project_exceeds_line_costs' OR r.profit_ex_unsuppressed IS DISTINCT FROM 1100) THEN
      RAISE EXCEPTION 'A2 credits contract: A2N-P1 (project holds the credited bill at its full amount) reads %, profit % (want no project flag, 1100)',
        r.cost_flag, r.profit_ex_unsuppressed;
    END IF;
    IF r.job_number IN ('A2N-P2', 'A2N-P3') AND (r.cost_flag <> 'xero_project_exceeds_line_costs' OR r.profit_ex_unsuppressed IS NOT NULL) THEN
      RAISE EXCEPTION 'A2 credits contract: % (project above the cost lines before credits) reads %, profit %', r.job_number, r.cost_flag,
        r.profit_ex_unsuppressed;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.v_job_profit WHERE job_number LIKE 'A2N-P%') <> 3 THEN
    RAISE EXCEPTION 'A2 credits contract: the three project jobs are not all in v_job_profit';
  END IF;
END $$;

-- and the objects are this migration's exact definitions
DO $$
BEGIN
  IF md5(pg_get_functiondef('public.job_profit_line_evidence_many(uuid[])'::regprocedure)) <> 'b9114d87ccc74b6171bbb51d92be69b4'
     OR md5(pg_get_functiondef('public.job_profit_line_evidence_score(date,date)'::regprocedure)) <> '26beb477a6461e70160c39b493f98c7f'
     OR md5(pg_get_viewdef('public.v_job_profit'::regclass, true)) <> '1ac286e983426f43c67f94fd84268e07' THEN
    RAISE EXCEPTION 'A2 credits contract: an object is not the 20261104200500 definition';
  END IF;
END $$;

ROLLBACK;
