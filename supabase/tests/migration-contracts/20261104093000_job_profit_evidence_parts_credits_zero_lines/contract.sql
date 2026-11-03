-- Contract for 20261104093000: job_profit_line_evidence_many checks a split part against Bookkeeping's part evidence,
-- a credit-note line Bookkeeping places against its own evidence, a credit through a materials fact, names a part
-- Job Profit does not carry, and leaves $0 lines out (a $0 crew line only once its crew invoice is in Xero).
-- Fixtures sit in one rolled-back transaction. The function's inputs are views built from the whole cost engine;
-- inside the transaction each is renamed aside and a table with its columns stands in, so the rule is tested on
-- exact rows. Nothing is kept.
BEGIN;
SET LOCAL statement_timeout = '60s';

ALTER VIEW public.v_job_cost_events RENAME TO v_job_cost_events_a2_aside;
ALTER VIEW public.v_job_profit RENAME TO v_job_profit_a2_aside;
ALTER VIEW public.v_bookkeeping_line_parts_current RENAME TO v_bookkeeping_line_parts_current_a2_aside;
ALTER TABLE public.trade_invoice_lines RENAME TO trade_invoice_lines_a2_aside;
ALTER TABLE public.trade_invoices RENAME TO trade_invoices_a2_aside;
ALTER TABLE public.v_xero_lines RENAME TO v_xero_lines_a2_aside;
ALTER TABLE public.v_bookkeeping_line_evidence_current RENAME TO v_bookkeeping_line_evidence_current_a2_aside;

CREATE TABLE public.v_job_cost_events (job_id uuid, source text, source_id text, document_id text, document_number text,
  description text, amount_ex numeric, event_date date, lane text, is_actual boolean);
CREATE TABLE public.v_job_profit (job_id uuid, margin_ok boolean, cost_flag text, invoiced_ex numeric, actual_cost_ex numeric);
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

-- Job A (a2a): every line with money evidenced; a $0 quote text line on its invoice; a $0 line on a crew invoice in Xero.
-- Job B (a2b): Bookkeeping places part 2 of the split line on B, Job Profit does not carry it there.
-- Job C (a2c): a $0 line on a crew invoice not yet in Xero.
INSERT INTO public.v_xero_lines VALUES
  ('INVA', 'ACCREC', 'INV-A', 'PAID', 'a2a00000-0000-0000-0000-000000000001', '2026-08-03', 'Client A', 1, 'IA1', 'Fence', '200', 'fencing', 1000, 'INVA:1'),
  ('INVA', 'ACCREC', 'INV-A', 'PAID', 'a2a00000-0000-0000-0000-000000000001', '2026-08-03', 'Client A', 2, 'IA2', 'Thank you for considering us', '200', 'fencing', 0, 'INVA:2'),
  ('INVB', 'ACCREC', 'INV-B', 'PAID', 'a2b00000-0000-0000-0000-000000000002', '2026-08-03', 'Client B', 1, 'IB1', 'Fence', '200', 'fencing', 500, 'INVB:1'),
  ('INVC', 'ACCREC', 'INV-C', 'PAID', 'a2c00000-0000-0000-0000-000000000003', '2026-08-03', 'Client C', 1, 'IC1', 'Make safe', '200', 'fencing', 400, 'INVC:1'),
  ('BILL1', 'ACCPAY', 'W1', 'PAID', NULL, '2026-08-04', 'Supplier', 1, 'L1', 'Sheets for two jobs', '310', 'fencing', 500, 'BILL1:1'),
  ('BILL2', 'ACCPAY', 'W2', 'PAID', NULL, '2026-08-04', 'Supplier', 1, 'L2', 'Panels', '310', 'fencing', 200, 'BILL2:1');
INSERT INTO public.v_bookkeeping_line_evidence_current (xero_invoice_id, xero_line_item_id, amount_ex_gst, allocation, job_number, job_id, evidenced, trade_invoice_line_id, revision) VALUES
  ('INVA', 'IA1', 1000, 'job', 'A2A', 'a2a00000-0000-0000-0000-000000000001', true, NULL, 'r1'),
  ('INVB', 'IB1', 500, 'job', 'A2B', 'a2b00000-0000-0000-0000-000000000002', true, NULL, 'r1'),
  ('INVC', 'IC1', 400, 'job', 'A2C', 'a2c00000-0000-0000-0000-000000000003', true, NULL, 'r1'),
  ('BILL2', 'L2', 200, 'job', 'A2A', 'a2a00000-0000-0000-0000-000000000001', true, NULL, 'r1'),
  ('CN1', 'CL1', -50, 'job', 'A2A', 'a2a00000-0000-0000-0000-000000000001', true, NULL, 'r1'),
  ('XB1', 'XL1', 100, 'job', 'A2A', 'a2a00000-0000-0000-0000-000000000001', true, 'a2f00000-0000-0000-0000-000000000011', 'r1');
INSERT INTO public.v_bookkeeping_line_parts_current (xero_invoice_id, xero_line_item_id, part, parts, line_ex, amount_ex_gst, allocation, job_number, job_id, evidenced, super_withheld, revision) VALUES
  ('BILL1', 'L1', 1, 2, 500, 300, 'job', 'A2A', 'a2a00000-0000-0000-0000-000000000001', true, false, 'r1'),
  ('BILL1', 'L1', 2, 2, 500, 200, 'job', 'A2B', 'a2b00000-0000-0000-0000-000000000002', true, false, 'r1');
INSERT INTO public.trade_invoices VALUES
  ('a2e00000-0000-0000-0000-000000000010', 'XB0'), ('a2e00000-0000-0000-0000-000000000011', 'XB1'),
  ('a2e00000-0000-0000-0000-000000000012', NULL);
INSERT INTO public.trade_invoice_lines VALUES
  ('a2f00000-0000-0000-0000-000000000010', 'a2e00000-0000-0000-0000-000000000010'),
  ('a2f00000-0000-0000-0000-000000000011', 'a2e00000-0000-0000-0000-000000000011'),
  ('a2f00000-0000-0000-0000-000000000012', 'a2e00000-0000-0000-0000-000000000012');
INSERT INTO public.v_job_cost_events VALUES
  ('a2a00000-0000-0000-0000-000000000001', 'supplier_bill', 'BILL1:1:part1', 'BILL1', 'W1', 'Sheets', 300, '2026-08-04', 'materials', true),
  ('a2a00000-0000-0000-0000-000000000001', 'supplier_credit', 'CN1:CL1:ledger_credit', 'CN1', 'CN-1', 'Supplier credit note CN-1 placed by Bookkeeping', -50, '2026-08-05', 'materials', true),
  ('a2a00000-0000-0000-0000-000000000001', 'materials_fact', 'F1', 'BILL2', 'W2', 'Panels', 200, '2026-08-04', 'materials', true),
  ('a2a00000-0000-0000-0000-000000000001', 'supplier_credit', 'F1:credit', 'BILL2', 'W2', 'Credit applied in Xero', -20, '2026-08-04', 'materials', true),
  ('a2a00000-0000-0000-0000-000000000001', 'trade_line', 'a2f00000-0000-0000-0000-000000000010', 'a2e00000-0000-0000-0000-000000000010', 'SW-INV-0', NULL, 0, '2026-08-02', 'labour', true),
  ('a2a00000-0000-0000-0000-000000000001', 'trade_line', 'a2f00000-0000-0000-0000-000000000011', 'a2e00000-0000-0000-0000-000000000011', 'SW-INV-1', 'Labour', 100, '2026-08-02', 'labour', true),
  ('a2c00000-0000-0000-0000-000000000003', 'trade_line', 'a2f00000-0000-0000-0000-000000000012', 'a2e00000-0000-0000-0000-000000000012', 'SW-INV-2', NULL, 0, '2026-08-02', 'labour', true);
INSERT INTO public.v_job_profit VALUES
  ('a2a00000-0000-0000-0000-000000000001', true, 'ok', 1000, 530),
  ('a2b00000-0000-0000-0000-000000000002', true, 'ok', 500, 0),
  ('a2c00000-0000-0000-0000-000000000003', true, 'ok', 400, 0);

DO $$
DECLARE a jsonb; b jsonb; c jsonb; s jsonb; st text;
BEGIN
  SELECT m.result INTO a FROM public.job_profit_line_evidence_many(ARRAY['a2a00000-0000-0000-0000-000000000001']::uuid[]) m;
  SELECT m.result INTO b FROM public.job_profit_line_evidence_many(ARRAY['a2b00000-0000-0000-0000-000000000002']::uuid[]) m;
  SELECT m.result INTO c FROM public.job_profit_line_evidence_many(ARRAY['a2c00000-0000-0000-0000-000000000003']::uuid[]) m;
  IF a ->> 'status' IS DISTINCT FROM 'verified' THEN
    RAISE EXCEPTION 'A2 contract: job A is not Verified: %', a -> 'why_not_verified';
  END IF;
  IF a ->> 'rule' <> 'r57-v3' OR (a ->> 'zero_amount_lines')::int <> 2 OR (a ->> 'items')::int <> 6 THEN
    RAISE EXCEPTION 'A2 contract: job A rule %, $0 lines %, items % (want r57-v3, 2, 6)', a ->> 'rule', a ->> 'zero_amount_lines', a ->> 'items';
  END IF;
  SELECT l ->> 'state' INTO st FROM jsonb_array_elements(a -> 'lines') l WHERE l ->> 'ref' = 'BILL1:1:part1';
  IF st IS DISTINCT FROM 'evidenced' THEN RAISE EXCEPTION 'A2 contract: the split part is %, not evidenced', st; END IF;
  SELECT l ->> 'state' INTO st FROM jsonb_array_elements(a -> 'lines') l WHERE l ->> 'ref' = 'CN1:CL1:ledger_credit';
  IF st IS DISTINCT FROM 'evidenced' THEN RAISE EXCEPTION 'A2 contract: the credit-note line is %, not evidenced', st; END IF;
  SELECT l ->> 'state' INTO st FROM jsonb_array_elements(a -> 'lines') l WHERE l ->> 'ref' = 'F1:credit';
  IF st IS DISTINCT FROM 'evidenced' THEN RAISE EXCEPTION 'A2 contract: the credit through a materials fact is %, not evidenced', st; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(a -> 'lines') l WHERE (l ->> 'amount_ex')::numeric = 0) THEN
    RAISE EXCEPTION 'A2 contract: a $0 line is still in job A''s check';
  END IF;
  IF b ->> 'status' <> 'provisional' OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(b -> 'lines') l
       WHERE l ->> 'ref' = 'BILL1:1:part2' AND l ->> 'state' = 'not_in_job_profit' AND (l ->> 'amount_ex')::numeric = 200) THEN
    RAISE EXCEPTION 'A2 contract: job B does not name the part Job Profit does not carry: %', b;
  END IF;
  IF c ->> 'status' <> 'provisional' OR (c ->> 'zero_amount_lines')::int <> 0 OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(c -> 'lines') l
       WHERE l ->> 'kind' = 'trade_line' AND l ->> 'state' = 'no_evidence') THEN
    RAISE EXCEPTION 'A2 contract: the $0 line on a crew invoice not in Xero no longer asks for evidence: %', c;
  END IF;
  -- the part's amount must agree: a part Job Profit carries at another amount is not evidenced
  UPDATE public.v_job_cost_events SET amount_ex = 299 WHERE source_id = 'BILL1:1:part1';
  SELECT l ->> 'state' INTO st FROM public.job_profit_line_evidence_many(ARRAY['a2a00000-0000-0000-0000-000000000001']::uuid[]) m,
    jsonb_array_elements(m.result -> 'lines') l WHERE l ->> 'ref' = 'BILL1:1:part1';
  IF st IS DISTINCT FROM 'no_evidence' THEN RAISE EXCEPTION 'A2 contract: a part at another amount reads %', st; END IF;
  UPDATE public.v_job_cost_events SET amount_ex = 300 WHERE source_id = 'BILL1:1:part1';
  -- the score counts job A (its $0 quote text line does not keep it out of the candidates)
  s := public.job_profit_line_evidence_score('2026-07-01', '2026-11-01');
  IF s ->> 'rule' <> 'r57-v3' OR (s ->> 'jobs_verified')::int <> 1 THEN
    RAISE EXCEPTION 'A2 contract: score rule %, jobs verified % (want r57-v3, 1)', s ->> 'rule', s ->> 'jobs_verified';
  END IF;
END $$;

-- and the functions are this migration's exact definitions
DO $$
BEGIN
  IF md5(pg_get_functiondef('public.job_profit_line_evidence_many(uuid[])'::regprocedure)) <> 'bd4fe36c7035eb3a6e28f4be2bebafca' THEN
    RAISE EXCEPTION 'A2 contract: job_profit_line_evidence_many is not the 20261104093000 definition';
  END IF;
  IF md5(pg_get_functiondef('public.job_profit_line_evidence_score(date,date)'::regprocedure)) <> 'd869f2e39cd71685d86a473e395e751e' THEN
    RAISE EXCEPTION 'A2 contract: job_profit_line_evidence_score is not the 20261104093000 definition';
  END IF;
END $$;

ROLLBACK;
