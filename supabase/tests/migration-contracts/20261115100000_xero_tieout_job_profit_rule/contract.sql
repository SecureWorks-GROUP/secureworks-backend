-- Contract for 20261115100000_xero_tieout_job_profit_rule: the monthly tie to Xero reads Job Profit's own cost rows.
--
-- Synthetic jobs and bills, no customer data, dated March 2034 so no other case's fixtures fall in the month read.
-- Everything rolls back. The read is called with a fixed as_of (2034-03-15), never the run's clock.
--
--   SWT-97001 a real job (TJ1).   SWT-97009 the holding job (do_not_schedule 'true').
--   Org 1 is ours; org 2 is another org, never read by an org-1 call.
--   March 2034 bills (ex GST), and where each lands:
--   TJ-EV     1000.00  no job on the bill; bookkeeping's evidence names TJ1        on a job (the route the old tie-out missed)
--   TJ-TXT     400.00  the line's text names the job number                        on a job (the other route it missed)
--   TJ-FACT    250.25  an AI placement on TJ1                                      on a job
--   TJ-LINK    120.10  Xero job link to TJ1                                        on a job
--   TJ-OHEV    300.00  evidence: overhead, no job                                  overhead (bookkeeping evidence)
--   TJ-NJC      80.40  evidence: not a job cost, no job                            overhead (bookkeeping evidence)
--   TJ-NJR      60.00  Bills to place: not job related                             overhead (filed)
--   TJ-SPLIT   999.99  a person's split: 800.00 on TJ1; 199.99 overhead, filed in Bills to place AND ruled by evidence: once
--   TJ-MIR     500.00  trade-app mirror                                            trade-app labour
--   TJ-OPEN    500.55  waiting in Bills to place                                   unplaced
--   TJ-HOLDB   120.00  Xero link to the holding job                                unplaced (holding)
--   TJ-INST    600.00  installer bill, Xero link only, nobody confirmed            unplaced (JP-12)
--   TJ-NONE     45.45  never reached the intake                                    unplaced
--   TJ-OVER    100.00  100.00 by evidence on TJ1, and evidence of 50.00 overhead   100 on job, 50 over
--   TJ-SHORT   200.00  one line of 150.00 by evidence on TJ1, one of 50.00 unread  150 on job, 50 unplaced (short)
--   Not counted: TJ-NEG (-60.00, negative_bill only), TJ-DRAFT (DRAFT), TJ-APR (dated April, after the as_of month).
--   Org 2: TJ-ORG2 700.00, by evidence on org 2's own job.
--
-- Expected March (org 1): total 5276.74 = on job 2820.35 + trade-app labour 500.00 + overhead 640.39 (filed 259.99,
-- bookkeeping evidence 380.40) + unplaced 1316.00, share 0.2494 (rounded up). Unplaced by reason: waiting 500.55,
-- holding 120.00, installer 600.00, not in intake 45.45, short 50.00. Over allocated: 1 bill, 50.00.
-- On a job is checked two ways: against the figures above, read from the fixture documents by hand, and against Job
-- Profit's own rows for the same bills (v_job_cost_events), so the two can never drift apart again.
-- With every org read: total 5976.74, on job 3520.35.
-- The function 20261030060000 left (this migration's down, in a savepoint) reads the same bills as on job 1170.35
-- and unplaced 3346.40: the gap this migration closes.

\set ON_ERROR_STOP on

BEGIN;

-- A later migration may replace this function. This contract is about this migration's body, so it stands that body
-- back up inside the transaction when the live one is another's that kept the slice name first in its comment.
SELECT COALESCE(obj_description('public.xero_tieout_monthly(date,integer,uuid)'::regprocedure, 'pg_proc'), '')
       LIKE 'TP-01 Xero tie-out, Job Profit rule (20261115100000%' AS tjp_own_body \gset
\if :tjp_own_body
\else
\echo 'the live tie-out is not 20261115100000''s: a later slice must roll itself back here first'
DO $$ BEGIN RAISE EXCEPTION 'xero tie-out job profit rule: the live tie-out is not 20261115100000''s'; END $$;
\endif

INSERT INTO public.organisations (id, name) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Synthetic org'),
  ('00000000-0000-0000-0000-000000000002', 'Synthetic org 2')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.jobs (id, org_id, status, type, job_number, metadata, pricing_json, created_at) VALUES
  ('b9000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'in_progress', 'fencing', 'SWT-97001', '{}', '{}', '2034-01-01'),
  ('b9000000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000001', 'in_progress', 'fencing', 'SWT-97009', '{"do_not_schedule": "true"}', '{}', '2034-01-01'),
  ('b9000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000002', 'in_progress', 'fencing', 'SWT-97002', '{}', '{}', '2034-01-01');

INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, line_items, raw_json, job_id, synced_at) VALUES
  ('00000000-0000-0000-0000-000000000001', 'TJ-EV', 'TJB-1', 'ACCPAY', 'PAID', 'TJ Steel', 1000.00, 1100.00, '2034-03-02',
   '[{"LineItemID": "ev1", "Description": "Posts", "AccountCode": "305", "LineAmount": 1000.00}]', '{"LineAmountTypes": "Exclusive"}', NULL, '2034-03-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TJ-TXT', 'TJB-2', 'ACCPAY', 'AUTHORISED', 'TJ Hardware', 400.00, 440.00, '2034-03-03',
   '[{"LineItemID": "tx1", "Description": "Rails for swt 97001", "AccountCode": "305", "LineAmount": 400.00}]', '{"LineAmountTypes": "Exclusive"}', NULL, '2034-03-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TJ-FACT', 'TJB-3', 'ACCPAY', 'PAID', 'TJ Timber', 250.25, 275.28, '2034-03-04',
   '[{"LineItemID": "fa1", "Description": "Timber", "AccountCode": "305", "LineAmount": 250.25}]', '{"LineAmountTypes": "Exclusive"}', NULL, '2034-03-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TJ-LINK', 'TJB-4', 'ACCPAY', 'PAID', 'TJ Steel', 120.10, 132.11, '2034-03-05',
   '[{"LineItemID": "li1", "Description": "Caps", "AccountCode": "305", "LineAmount": 120.10}]', '{"LineAmountTypes": "Exclusive"}', 'b9000000-0000-4000-8000-000000000001', '2034-03-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TJ-OHEV', 'TJB-5', 'ACCPAY', 'AUTHORISED', 'TJ Office', 300.00, 330.00, '2034-03-06',
   '[{"LineItemID": "oh1", "Description": "Printer", "AccountCode": "400", "LineAmount": 300.00}]', '{"LineAmountTypes": "Exclusive"}', NULL, '2034-03-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TJ-NJC', 'TJB-6', 'ACCPAY', 'AUTHORISED', 'TJ Office', 80.40, 88.44, '2034-03-07',
   '[{"LineItemID": "nj1", "Description": "Bond", "AccountCode": "400", "LineAmount": 80.40}]', '{"LineAmountTypes": "Exclusive"}', NULL, '2034-03-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TJ-NJR', 'TJB-7', 'ACCPAY', 'AUTHORISED', 'TJ Office', 60.00, 66.00, '2034-03-08',
   '[{"LineItemID": "nr1", "Description": "Paper", "AccountCode": "400", "LineAmount": 60.00}]', '{"LineAmountTypes": "Exclusive"}', NULL, '2034-03-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TJ-SPLIT', 'TJB-8', 'ACCPAY', 'AUTHORISED', 'TJ Steel', 999.99, 1099.99, '2034-03-09',
   '[{"LineItemID": "sp1", "Description": "Sheets", "AccountCode": "305", "LineAmount": 800.00}, {"LineItemID": "sp2", "Description": "Shed stock", "AccountCode": "305", "LineAmount": 199.99}]', '{"LineAmountTypes": "Exclusive"}', NULL, '2034-03-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TJ-MIR', 'TJB-9', 'ACCPAY', 'PAID', 'TJ Trade', 500.00, 500.00, '2034-03-10',
   '[{"LineItemID": "mi1", "Description": "Week | SW - FENCING", "AccountCode": "306", "LineAmount": 500}]', '{"LineAmountTypes": "NoTax"}', NULL, '2034-03-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TJ-OPEN', 'TJB-10', 'ACCPAY', 'AUTHORISED', 'TJ Steel', 500.55, 550.61, '2034-03-11',
   '[{"LineItemID": "op1", "Description": "Sheets", "AccountCode": "305", "LineAmount": 500.55}]', '{"LineAmountTypes": "Exclusive"}', NULL, '2034-03-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TJ-HOLDB', 'TJB-11', 'ACCPAY', 'AUTHORISED', 'TJ Steel', 120.00, 132.00, '2034-03-12',
   '[{"LineItemID": "ho1", "Description": "Brackets", "AccountCode": "305", "LineAmount": 120.00}]', '{"LineAmountTypes": "Exclusive"}', 'b9000000-0000-4000-8000-000000000009', '2034-03-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TJ-INST', 'TJB-12', 'ACCPAY', 'AUTHORISED', 'TJ Installer', 600.00, 660.00, '2034-03-13',
   '[{"LineItemID": "in1", "Description": "Install", "AccountCode": "301", "LineAmount": 600.00}]', '{"LineAmountTypes": "Exclusive"}', 'b9000000-0000-4000-8000-000000000001', '2034-03-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TJ-NONE', 'TJB-13', 'ACCPAY', 'AUTHORISED', 'TJ Fuel', 45.45, 50.00, '2034-03-14',
   '[{"LineItemID": "no1", "Description": "Fuel", "AccountCode": "449", "LineAmount": 45.45}]', '{"LineAmountTypes": "Exclusive"}', NULL, '2034-03-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TJ-OVER', 'TJB-14', 'ACCPAY', 'AUTHORISED', 'TJ Steel', 100.00, 110.00, '2034-03-15',
   '[{"LineItemID": "ov1", "Description": "Bolts", "AccountCode": "305", "LineAmount": 100.00}]', '{"LineAmountTypes": "Exclusive"}', NULL, '2034-03-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TJ-SHORT', 'TJB-15', 'ACCPAY', 'AUTHORISED', 'TJ Steel', 200.00, 220.00, '2034-03-16',
   '[{"LineItemID": "sh1", "Description": "Gates", "AccountCode": "305", "LineAmount": 150.00}, {"LineItemID": "sh2", "Description": "Hinges", "AccountCode": "305", "LineAmount": 50.00}]', '{"LineAmountTypes": "Exclusive"}', NULL, '2034-03-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TJ-NEG', 'TJB-16', 'ACCPAY', 'AUTHORISED', 'TJ Steel', -60.00, -66.00, '2034-03-17',
   '[{"LineItemID": "ne1", "Description": "Refund", "AccountCode": "305", "LineAmount": -60.00}]', '{"LineAmountTypes": "Exclusive"}', NULL, '2034-03-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TJ-DRAFT', 'TJB-17', 'ACCPAY', 'DRAFT', 'TJ Steel', 77.77, 85.55, '2034-03-18',
   '[{"LineItemID": "dr1", "Description": "Draft", "AccountCode": "305", "LineAmount": 77.77}]', '{"LineAmountTypes": "Exclusive"}', NULL, '2034-03-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TJ-APR', 'TJB-18', 'ACCPAY', 'AUTHORISED', 'TJ Steel', 999.00, 1098.90, '2034-04-02',
   '[{"LineItemID": "ap1", "Description": "Later", "AccountCode": "305", "LineAmount": 999.00}]', '{"LineAmountTypes": "Exclusive"}', NULL, '2034-03-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000002', 'TJ-ORG2', 'TJB-19', 'ACCPAY', 'AUTHORISED', 'TJ Other', 700.00, 770.00, '2034-03-19',
   '[{"LineItemID": "o21", "Description": "Other org", "AccountCode": "305", "LineAmount": 700.00}]', '{"LineAmountTypes": "Exclusive"}', NULL, '2034-03-15T00:00:00Z');

-- Bookkeeping's current line evidence (a table stands in for the view in this stack).
INSERT INTO public.v_bookkeeping_line_evidence_current
  (xero_invoice_id, xero_line_item_id, amount_ex_gst, allocation, job_number, job_id, evidenced, basis, revision, stream, emitted_at) VALUES
  ('TJ-EV', 'ev1', 1000.00, 'job', 'SWT-97001', 'b9000000-0000-4000-8000-000000000001', true, 'supplier_document_job_number', 'tjp-r1', 'tjp-ledger-cost', '2034-03-15'),
  ('TJ-OHEV', 'oh1', 300.00, 'overhead', NULL, NULL, true, 'ledger_account', 'tjp-r1', 'tjp-ledger-cost', '2034-03-15'),
  ('TJ-NJC', 'nj1', 80.40, 'not_job_cost', NULL, NULL, true, 'ledger_account', 'tjp-r1', 'tjp-ledger-cost', '2034-03-15'),
  ('TJ-SPLIT', 'sp2', 199.99, 'overhead', NULL, NULL, true, 'ledger_account', 'tjp-r1', 'tjp-ledger-cost', '2034-03-15'),
  ('TJ-OVER', 'ov1', 100.00, 'job', 'SWT-97001', 'b9000000-0000-4000-8000-000000000001', true, 'supplier_document_job_number', 'tjp-r1', 'tjp-ledger-cost', '2034-03-15'),
  ('TJ-OVER', 'ov2', 50.00, 'overhead', NULL, NULL, true, 'ledger_account', 'tjp-r1', 'tjp-ledger-cost', '2034-03-15'),
  ('TJ-SHORT', 'sh1', 150.00, 'job', 'SWT-97001', 'b9000000-0000-4000-8000-000000000001', true, 'supplier_document_job_number', 'tjp-r1', 'tjp-ledger-cost', '2034-03-15'),
  -- Not evidenced: an overhead ruling nobody has backed is no ruling.
  ('TJ-OPEN', 'op1', 500.55, 'overhead', NULL, NULL, false, 'ledger_account', 'tjp-r1', 'tjp-ledger-cost', '2034-03-15'),
  ('TJ-ORG2', 'o21', 700.00, 'job', 'SWT-97002', 'b9000000-0000-4000-8000-000000000002', true, 'supplier_document_job_number', 'tjp-r1', 'tjp-ledger-cost', '2034-03-15');

INSERT INTO public.materials_reconciliation_queue (xero_invoice_id, invoice_number, contact_name, sub_total, total, invoice_date, status, overhead_ex) VALUES
  ('TJ-NJR', 'TJB-7', 'TJ Office', 60.00, 66.00, '2034-03-08', 'not_job_related', NULL),
  ('TJ-SPLIT', 'TJB-8', 'TJ Steel', 999.99, 1099.99, '2034-03-09', 'split', 199.99),
  ('TJ-MIR', 'TJB-9', 'TJ Trade', 500.00, 500.00, '2034-03-10', 'open', NULL),
  ('TJ-OPEN', 'TJB-10', 'TJ Steel', 500.55, 550.61, '2034-03-11', 'open', NULL),
  ('TJ-NEG', 'TJB-16', 'TJ Steel', -60.00, -66.00, '2034-03-17', 'open', NULL);

INSERT INTO public.job_materials_facts (org_id, xero_invoice_id, invoice_number, contact_name, job_id, job_number, lane, kind, amount_ex_gst, confidence, automation_source, fact_date) VALUES
  ('00000000-0000-0000-0000-000000000001', 'TJ-FACT', 'TJB-3', 'TJ Timber', 'b9000000-0000-4000-8000-000000000001', 'SWT-97001', 'materials', 'actual', 250.25, 'high', 'agent_ai', '2034-03-04'),
  ('00000000-0000-0000-0000-000000000001', 'TJ-SPLIT', 'TJB-8', 'TJ Steel', 'b9000000-0000-4000-8000-000000000001', 'SWT-97001', 'materials', 'actual', 800.00, 'high_manual', 'manual_split', '2034-03-09');

CREATE TEMP TABLE tjp_checks(name text, passed boolean);
CREATE FUNCTION pg_temp.prove(n text, p boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  IF p IS DISTINCT FROM true THEN RAISE EXCEPTION 'xero tie-out job profit rule: %', n; END IF;
  INSERT INTO tjp_checks VALUES (n, p);
END $$;

DO $test$
DECLARE
  org1 uuid := '00000000-0000-0000-0000-000000000001';
  tj1 uuid := 'b9000000-0000-4000-8000-000000000001';
  v jsonb := public.xero_tieout_monthly('2034-03-15', 1, '00000000-0000-0000-0000-000000000001');
  b jsonb;
  engine_on_job numeric;
BEGIN
  IF jsonb_array_length(v -> 'months') <> 1 OR v -> 'months' -> 0 ->> 'month' <> '2034-03' THEN
    RAISE EXCEPTION 'xero tie-out job profit rule: months shown: %', v -> 'months';
  END IF;
  b := v -> 'months' -> 0 -> 'bills';

  -- The fixtures reach Job Profit's cost view the way the comments above say.
  PERFORM pg_temp.prove('fixture: bookkeeping evidence puts TJ-EV on the job in Job Profit',
    (SELECT sum(amount_ex) FROM public.v_job_cost_events WHERE document_id = 'TJ-EV' AND job_id = tj1 AND is_actual AND match_method = 'bookkeeping_evidence') = 1000.00);
  PERFORM pg_temp.prove('fixture: a job number on the line puts TJ-TXT on the job in Job Profit',
    (SELECT sum(amount_ex) FROM public.v_job_cost_events WHERE document_id = 'TJ-TXT' AND job_id = tj1 AND is_actual AND match_method = 'bill_line_job_number') = 400.00);
  PERFORM pg_temp.prove('fixture: Job Profit holds the unconfirmed installer bill back',
    EXISTS (SELECT 1 FROM public.v_job_cost_events WHERE document_id = 'TJ-INST' AND source = 'installer_bill_unconfirmed' AND NOT is_actual AND amount_ex = 600.00)
    AND NOT EXISTS (SELECT 1 FROM public.v_job_cost_events WHERE document_id = 'TJ-INST' AND is_actual));

  -- March, org 1, against the figures read from the fixture documents by hand.
  IF (b ->> 'on_job_ex')::numeric <> 2820.35 THEN
    RAISE EXCEPTION 'xero tie-out job profit rule: March on_job_ex: %', b ->> 'on_job_ex';
  END IF;
  PERFORM pg_temp.prove('March total 5276.74 over 15 bills', (b ->> 'total_ex')::numeric = 5276.74 AND (b ->> 'count')::int = 15
    AND (v -> 'months' -> 0 ->> 'tie_out_total_ex')::numeric = 5276.74);
  PERFORM pg_temp.prove('March trade-app labour 500.00', (b ->> 'trade_app_labour_ex')::numeric = 500.00);
  PERFORM pg_temp.prove('March overhead 640.39: ' || (b -> 'non_job' ->> 'overhead_not_job_related_ex'),
    (b -> 'non_job' ->> 'overhead_not_job_related_ex')::numeric = 640.39);
  PERFORM pg_temp.prove('overhead by basis: filed 259.99, bookkeeping evidence 380.40 (a line both name is counted once): ' || (b -> 'non_job' -> 'by_basis')::text,
    (b -> 'non_job' -> 'by_basis' ->> 'filed_in_bills_to_place_ex')::numeric = 259.99
    AND (b -> 'non_job' -> 'by_basis' ->> 'bookkeeping_evidence_ex')::numeric = 380.40);
  PERFORM pg_temp.prove('March unplaced 1316.00, share 0.2494 (rounded up): ' || (b ->> 'unplaced_ex') || ' ' || (b ->> 'unplaced_share'),
    (b ->> 'unplaced_ex')::numeric = 1316.00 AND (b ->> 'unplaced_share')::numeric = 0.2494);
  PERFORM pg_temp.prove('unplaced by reason: ' || (b -> 'unplaced_by_reason')::text,
    (b -> 'unplaced_by_reason' ->> 'waiting_in_bills_to_place')::numeric = 500.55
    AND (b -> 'unplaced_by_reason' ->> 'holding_job')::numeric = 120.00
    AND (b -> 'unplaced_by_reason' ->> 'installer_awaiting_confirmation')::numeric = 600.00
    AND (b -> 'unplaced_by_reason' ->> 'not_in_intake')::numeric = 45.45
    AND (b -> 'unplaced_by_reason' ->> 'rows_short_of_bill')::numeric = 50.00);
  PERFORM pg_temp.prove('over allocated: 1 bill, 50.00, not in the total: ' || (b -> 'over_allocated')::text,
    (b -> 'over_allocated' ->> 'bills')::int = 1 AND (b -> 'over_allocated' ->> 'ex')::numeric = 50.00
    AND (b -> 'over_allocated' ->> 'counted')::boolean = false);
  PERFORM pg_temp.prove('negative bill: 1 bill, -60.00, not in the total',
    (b -> 'negative_bill' ->> 'bills')::int = 1 AND (b -> 'negative_bill' ->> 'ex')::numeric = -60.00);
  PERFORM pg_temp.prove('the parts add up to the bills read directly', (b ->> 'parts_add_up')::boolean
    AND (b ->> 'on_job_ex')::numeric + (b ->> 'trade_app_labour_ex')::numeric
        + (b -> 'non_job' ->> 'overhead_not_job_related_ex')::numeric + (b ->> 'unplaced_ex')::numeric = (b ->> 'total_ex')::numeric);
  PERFORM pg_temp.prove('the draft is shown as not counted', (v -> 'months' -> 0 -> 'not_counted' ->> 'draft_or_submitted_bills')::int = 1
    AND (v -> 'months' -> 0 -> 'not_counted' ->> 'draft_or_submitted_ex')::numeric = 77.77);
  PERFORM pg_temp.prove('last 6 months: 5276.74 total, 1316.00 unplaced, 0.2494 / 0.7506',
    (v -> 'last_6_months' ->> 'bills_total_ex')::numeric = 5276.74 AND (v -> 'last_6_months' ->> 'unplaced_ex')::numeric = 1316.00
    AND (v -> 'last_6_months' ->> 'unplaced_share_of_bills')::numeric = 0.2494
    AND (v -> 'last_6_months' ->> 'accounted_share_of_bills')::numeric = 0.7506);

  -- The same figure from Job Profit's own rows: per counted bill that is not trade-app labour, its actual rows on a
  -- job that is not a holding job, capped at the bill.
  SELECT sum(LEAST(GREATEST(COALESCE(e.ex, 0), 0), x.sub_total)) INTO engine_on_job
    FROM public.xero_invoices x
    LEFT JOIN LATERAL (
      SELECT sum(c.amount_ex) AS ex
        FROM public.v_job_cost_events c
        JOIN public.jobs j ON j.id = c.job_id
       WHERE c.document_id = x.xero_invoice_id AND c.is_actual AND c.source IN ('supplier_bill', 'materials_fact')
         AND j.org_id = x.org_id AND lower(COALESCE(j.metadata ->> 'do_not_schedule', '')) <> 'true') e ON true
   WHERE x.org_id = org1 AND x.invoice_type = 'ACCPAY' AND x.status IN ('AUTHORISED', 'PAID') AND x.sub_total >= 0
     AND x.invoice_date >= '2034-03-01' AND x.invoice_date < '2034-04-01' AND x.xero_invoice_id <> 'TJ-MIR';
  PERFORM pg_temp.prove('on a job equals Job Profit''s own rows for the same bills: ' || engine_on_job, engine_on_job = (b ->> 'on_job_ex')::numeric);
  PERFORM pg_temp.prove('Job Profit''s cost of the job is the same dollars: ' || (SELECT actual_cost_ex FROM public.v_job_profit WHERE job_id = tj1),
    (SELECT actual_cost_ex FROM public.v_job_profit WHERE job_id = tj1) = 2820.35);

  -- The answer keeps every key the page reads and says which rule sorted it.
  PERFORM pg_temp.prove('keys kept and the rule named',
    v ? 'as_of' AND v ? 'as_of_reads' AND v ? 'org_id' AND v ? 'months_shown' AND v ? 'from_month' AND v ? 'basis' AND v ? 'covers'
    AND v ? 'copy_synced_at' AND v ? 'not_yet_read' AND v ? 'last_6_months' AND v ? 'undated_bills' AND v ? 'months'
    AND (v ->> 'complete')::boolean = false AND v ->> 'on_job_rule' LIKE 'on_job_ex is what Job Profit counts%'
    AND b ? 'count' AND b ? 'total_inc' AND b ? 'amount_unknown_count' AND b ? 'parts_check'
    AND b -> 'non_job' ? 'stock_ex' AND b -> 'non_job' ->> 'stock_and_vehicles' = 'not_yet_separated'
    AND v -> 'months' -> 0 -> 'spend' ->> 'status' = 'not_yet_read' AND v -> 'months' -> 0 -> 'spend' -> 'amount_ex' = 'null'::jsonb
    AND v -> 'months' -> 0 -> 'credit_notes' ->> 'status' = 'not_yet_read' AND v -> 'months' -> 0 -> 'credit_notes' -> 'amount_ex' = 'null'::jsonb);

  -- Every org: org 2's bill is read with org 2's own job; org 1's call never saw it.
  v := public.xero_tieout_monthly('2034-03-15', 1, NULL);
  b := v -> 'months' -> 0 -> 'bills';
  PERFORM pg_temp.prove('every org: total 5976.74, on job 3520.35: ' || (b ->> 'total_ex') || ' ' || (b ->> 'on_job_ex'),
    (b ->> 'total_ex')::numeric = 5976.74 AND (b ->> 'on_job_ex')::numeric = 3520.35 AND (b ->> 'unplaced_ex')::numeric = 1316.00);
  v := public.xero_tieout_monthly('2034-03-15', 1, '00000000-0000-0000-0000-000000000002');
  b := v -> 'months' -> 0 -> 'bills';
  PERFORM pg_temp.prove('org 2 alone: its one bill, on its own job',
    (b ->> 'total_ex')::numeric = 700.00 AND (b ->> 'on_job_ex')::numeric = 700.00 AND (b ->> 'unplaced_ex')::numeric = 0);
END $test$;

-- Grants and shape: service role only, read only (STABLE), the search path pinned.
DO $grants$
DECLARE fn regprocedure := 'public.xero_tieout_monthly(date,integer,uuid)'::regprocedure;
BEGIN
  PERFORM pg_temp.prove('anon and authenticated cannot call it; the service role can',
    NOT has_function_privilege('anon', fn, 'EXECUTE') AND NOT has_function_privilege('authenticated', fn, 'EXECUTE')
    AND has_function_privilege('service_role', fn, 'EXECUTE'));
  PERFORM pg_temp.prove('stable, with its search path pinned',
    (SELECT p.provolatile = 's' AND p.proconfig = ARRAY['search_path=public, pg_temp'] FROM pg_proc p WHERE p.oid = fn));
END $grants$;

-- Applying the migration again changes nothing.
CREATE TEMP TABLE tjp_before AS
SELECT public.xero_tieout_monthly('2034-03-15', 1, '00000000-0000-0000-0000-000000000001')::text AS doc,
       (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = 'public.xero_tieout_monthly(date,integer,uuid)'::regprocedure) AS src_md5;
\ir ../../../migrations/20261115100000_xero_tieout_job_profit_rule.sql
DO $again$
BEGIN
  PERFORM pg_temp.prove('a second apply is a no-op',
    (SELECT doc FROM tjp_before) = public.xero_tieout_monthly('2034-03-15', 1, '00000000-0000-0000-0000-000000000001')::text
    AND (SELECT src_md5 FROM tjp_before) = (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = 'public.xero_tieout_monthly(date,integer,uuid)'::regprocedure));
END $again$;

-- While this body is live, the two earlier tie-out migrations and their downs refuse it: their guards accept only a
-- comment that starts 'TP-01 Xero tie-out (20261029121500)', and this one does not, so neither can put an older
-- sorting back without this migration's own down being run first.
DO $refuse$
BEGIN
  PERFORM pg_temp.prove('the earlier migrations'' guards do not accept this body',
    COALESCE(obj_description('public.xero_tieout_monthly(date,integer,uuid)'::regprocedure, 'pg_proc'), '') NOT LIKE 'TP-01 Xero tie-out (20261029121500)%'
    AND COALESCE(obj_description('public.xero_tieout_monthly(date,integer,uuid)'::regprocedure, 'pg_proc'), '') LIKE 'TP-01 Xero tie-out, Job Profit rule (20261115100000%');
END $refuse$;

-- The function 20261030060000 left (this migration's down, exactly), on the same bills: the gap this closes.
SAVEPOINT tjp_earlier;
\ir ../../../rollbacks/20261115100000_xero_tieout_job_profit_rule_down.sql
DO $earlier$
DECLARE b jsonb := public.xero_tieout_monthly('2034-03-15', 1, '00000000-0000-0000-0000-000000000001') -> 'months' -> 0 -> 'bills';
BEGIN
  PERFORM pg_temp.prove('the down restores 20261030060000''s body',
    (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = 'public.xero_tieout_monthly(date,integer,uuid)'::regprocedure) = 'e0d6ef30a46cd98dd8c5fc67b46ca1ef');
  PERFORM pg_temp.prove('the earlier function reads the same bills as 1170.35 on a job and 3346.40 unplaced: ' || (b ->> 'on_job_ex') || ' ' || (b ->> 'unplaced_ex'),
    (b ->> 'total_ex')::numeric = 5276.74 AND (b ->> 'on_job_ex')::numeric = 1170.35 AND (b ->> 'unplaced_ex')::numeric = 3346.40);
END $earlier$;
ROLLBACK TO SAVEPOINT tjp_earlier;

SELECT jsonb_build_object('checks', count(*), 'passed', count(*) FILTER (WHERE passed)) AS result FROM tjp_checks;

ROLLBACK;
