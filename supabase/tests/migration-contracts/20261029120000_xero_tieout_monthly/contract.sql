-- Contract for 20261029120000_xero_tieout_monthly (TP-01).
--
-- Synthetic jobs and bills, no customer data, dated in 2031 so no other
-- case's fixtures fall in the months read. Everything rolls back. The read is
-- called with a fixed as_of (2031-10-15), never the run's clock.
--
--   TO-J1    a real job.   TO-HOLD  the holding job (do_not_schedule).
--   October 2031 bills (ex GST):
--   TO-FACT   1000.10  a rule's row on TO-J1                 on a job
--   TO-LINK    250.25  Xero job link to TO-J1, no row        on a job
--   TO-NJR      80.40  Bills to place: not job related       overhead
--   TO-MIR     300.00  trade-app mirror                      trade-app mirror
--   TO-OPEN    500.55  waiting in Bills to place             unplaced
--   TO-HROW    120.00  a row on the holding job              unplaced (holding)
--   TO-SPLIT   999.99  split: 800.00 on TO-J1, 199.99 overhead
--   TO-INST    600.00  installer bill, Xero link only        unplaced (JP-12)
--   TO-NONE     45.45  never reached the intake              unplaced
--   TO-OVER    100.00  AI row of 150.00 on TO-J1             100 on job, 50 over
--   TO-SHORT   200.00  a person's row of 150.00              150 on job, 50 unplaced
--   TO-DUP      10.01  two copies (one DELETED): counted once, not in intake
--   Not counted: TO-DRAFT (DRAFT), TO-VOID (VOIDED), TO-SALE (ACCREC),
--   TO-NOV (dated November, after the as_of month).
--   September 2031: TO-SEP 400.00 on TO-J1, TO-SEPO 100.00 waiting.
--   April 2031:     TO-APR 1000.00 waiting (outside the last 6 months).
--   Bank copy: one October SPEND of 110.00 ex, one RECEIVE (ignored).
--
-- Expected October: total 4206.75 = on job 2300.35 + overhead 280.39 +
-- mirror 300.00 + unplaced 1326.01, share 0.3153 (rounded up). Last 6 months
-- (May to October): 4706.75 total, 1426.01 unplaced, share 0.3030. Credit
-- notes and spend are not_yet_read with null amounts, never 0.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, pricing_json, expected_costs, created_at) VALUES
  ('b7000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'complete', 'patio', 'TO-J1', false, '{}', '{}', NULL, '2031-01-01T00:00:00Z'),
  ('b7000000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'TO-HOLD', false, '{"do_not_schedule": "true"}', '{}', NULL, '2031-01-01T00:00:00Z');

INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, line_items, raw_json, job_id, synced_at) VALUES
  ('00000000-0000-0000-0000-000000000001', 'TO-FACT', 'TOB-1', 'ACCPAY', 'PAID', 'TO Steel', 1000.10, 1100.11, '2031-10-02',
   '[{"Description": "Posts", "AccountCode": "310", "LineAmount": 1000.10}]', '{}', NULL, '2031-10-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TO-LINK', 'TOB-2', 'ACCPAY', 'PAID', 'TO Steel', 250.25, 275.28, '2031-10-03',
   '[{"Description": "Rails", "AccountCode": "310", "LineAmount": 250.25}]', '{}', 'b7000000-0000-4000-8000-000000000001', '2031-10-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TO-NJR', 'TOB-3', 'ACCPAY', 'AUTHORISED', 'TO Office', 80.40, 88.44, '2031-10-04',
   '[{"Description": "Paper", "AccountCode": "400", "LineAmount": 80.40}]', '{}', NULL, '2031-10-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TO-MIR', 'TOB-4', 'ACCPAY', 'PAID', 'TO Trade', 300.00, 300.00, '2031-10-05',
   '[{"Description": "Week | SW - FENCING", "AccountCode": "306", "LineAmount": 300}]', '{}', NULL, '2031-10-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TO-OPEN', 'TOB-5', 'ACCPAY', 'AUTHORISED', 'TO Steel', 500.55, 550.61, '2031-10-06',
   '[{"Description": "Sheets", "AccountCode": "310", "LineAmount": 500.55}]', '{}', NULL, '2031-10-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TO-HROW', 'TOB-6', 'ACCPAY', 'AUTHORISED', 'TO Steel', 120.00, 132.00, '2031-10-07',
   '[{"Description": "Caps", "AccountCode": "310", "LineAmount": 120}]', '{}', 'b7000000-0000-4000-8000-000000000009', '2031-10-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TO-SPLIT', 'TOB-7', 'ACCPAY', 'AUTHORISED', 'TO Steel', 999.99, 1099.99, '2031-10-08',
   '[{"Description": "Mixed", "AccountCode": "310", "LineAmount": 999.99}]', '{}', NULL, '2031-10-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TO-INST', 'TOB-8', 'ACCPAY', 'AUTHORISED', 'TO Installer', 600.00, 660.00, '2031-10-09',
   '[{"Description": "Install", "AccountCode": "301", "LineAmount": 600}]', '{}', 'b7000000-0000-4000-8000-000000000001', '2031-10-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TO-NONE', 'TOB-9', 'ACCPAY', 'AUTHORISED', 'TO Fuel', 45.45, 50.00, '2031-10-10',
   '[{"Description": "Fuel", "AccountCode": "449", "LineAmount": 45.45}]', '{}', NULL, '2031-10-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TO-OVER', 'TOB-10', 'ACCPAY', 'AUTHORISED', 'TO Steel', 100.00, 110.00, '2031-10-11',
   '[{"Description": "Bolts", "AccountCode": "310", "LineAmount": 100}]', '{}', NULL, '2031-10-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TO-SHORT', 'TOB-11', 'ACCPAY', 'AUTHORISED', 'TO Steel', 200.00, 220.00, '2031-10-12',
   '[{"Description": "Gates", "AccountCode": "310", "LineAmount": 200}]', '{}', NULL, '2031-10-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TO-DUP', 'TOB-12', 'ACCPAY', 'AUTHORISED', 'TO Steel', 10.01, 11.01, '2031-10-13',
   '[{"Description": "Clips", "AccountCode": "310", "LineAmount": 10.01}]', '{}', NULL, '2031-10-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000002', 'TO-DUP', 'TOB-12', 'ACCPAY', 'DELETED', 'TO Steel', 10.01, 11.01, '2031-10-13',
   '[{"Description": "Clips", "AccountCode": "310", "LineAmount": 10.01}]', '{}', NULL, '2031-10-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TO-DRAFT', 'TOB-13', 'ACCPAY', 'DRAFT', 'TO Steel', 77.77, 85.55, '2031-10-14',
   '[{"Description": "Draft", "AccountCode": "310", "LineAmount": 77.77}]', '{}', NULL, '2031-10-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TO-VOID', 'TOB-14', 'ACCPAY', 'VOIDED', 'TO Steel', 66.66, 73.33, '2031-10-14',
   '[{"Description": "Void", "AccountCode": "310", "LineAmount": 66.66}]', '{}', NULL, '2031-10-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TO-SALE', 'TOI-1', 'ACCREC', 'AUTHORISED', 'TO Client', 5000.00, 5500.00, '2031-10-14',
   '[{"Description": "Patio", "AccountCode": "200", "LineAmount": 5000}]', '{}', 'b7000000-0000-4000-8000-000000000001', '2031-10-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TO-NOV', 'TOB-15', 'ACCPAY', 'AUTHORISED', 'TO Steel', 999.00, 1098.90, '2031-11-02',
   '[{"Description": "Later", "AccountCode": "310", "LineAmount": 999}]', '{}', NULL, '2031-10-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TO-SEP', 'TOB-16', 'ACCPAY', 'PAID', 'TO Steel', 400.00, 440.00, '2031-09-20',
   '[{"Description": "Posts", "AccountCode": "310", "LineAmount": 400}]', '{}', NULL, '2031-10-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TO-SEPO', 'TOB-17', 'ACCPAY', 'AUTHORISED', 'TO Steel', 100.00, 110.00, '2031-09-21',
   '[{"Description": "Posts", "AccountCode": "310", "LineAmount": 100}]', '{}', NULL, '2031-10-15T00:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'TO-APR', 'TOB-18', 'ACCPAY', 'AUTHORISED', 'TO Steel', 1000.00, 1100.00, '2031-04-20',
   '[{"Description": "Posts", "AccountCode": "310", "LineAmount": 1000}]', '{}', NULL, '2031-10-15T00:00:00Z');

INSERT INTO public.materials_reconciliation_queue (xero_invoice_id, invoice_number, contact_name, sub_total, total, invoice_date, status, overhead_ex) VALUES
  ('TO-NJR', 'TOB-3', 'TO Office', 80.40, 88.44, '2031-10-04', 'not_job_related', NULL),
  ('TO-MIR', 'TOB-4', 'TO Trade', 300.00, 300.00, '2031-10-05', 'open', NULL),
  ('TO-OPEN', 'TOB-5', 'TO Steel', 500.55, 550.61, '2031-10-06', 'open', NULL),
  ('TO-HROW', 'TOB-6', 'TO Steel', 120.00, 132.00, '2031-10-07', 'assigned', NULL),
  ('TO-SPLIT', 'TOB-7', 'TO Steel', 999.99, 1099.99, '2031-10-08', 'split', 199.99),
  ('TO-SHORT', 'TOB-11', 'TO Steel', 200.00, 220.00, '2031-10-12', 'assigned', NULL),
  ('TO-SEPO', 'TOB-17', 'TO Steel', 100.00, 110.00, '2031-09-21', 'open', NULL),
  ('TO-APR', 'TOB-18', 'TO Steel', 1000.00, 1100.00, '2031-04-20', 'open', NULL);

INSERT INTO public.job_materials_facts (xero_invoice_id, job_id, job_number, lane, kind, amount_ex_gst, confidence, automation_source, fact_date) VALUES
  ('TO-FACT', 'b7000000-0000-4000-8000-000000000001', 'TO-J1', 'materials', 'actual', 1000.10, 'medium', 'po_deterministic', '2031-10-02'),
  ('TO-HROW', 'b7000000-0000-4000-8000-000000000009', 'TO-HOLD', 'materials', 'actual', 120.00, 'high', 'xero_ref_link', '2031-10-07'),
  ('TO-SPLIT', 'b7000000-0000-4000-8000-000000000001', 'TO-J1', 'materials', 'actual', 800.00, 'high_manual', 'manual_split', '2031-10-08'),
  ('TO-OVER', 'b7000000-0000-4000-8000-000000000001', 'TO-J1', 'materials', 'actual', 150.00, 'high', 'agent_ai', '2031-10-11'),
  ('TO-SHORT', 'b7000000-0000-4000-8000-000000000001', 'TO-J1', 'materials', 'actual', 150.00, 'high_manual', 'manual_queue', '2031-10-12'),
  ('TO-SEP', 'b7000000-0000-4000-8000-000000000001', 'TO-J1', 'materials', 'actual', 400.00, 'high', 'xero_ref_link', '2031-09-20');

INSERT INTO public.xero_bank_transactions (xero_txn_id, account_id, txn_date, txn_type, amount, sub_total, total_tax, status, synced_at) VALUES
  ('TO-SPEND-1', 'TO-BANK', '2031-10-09', 'SPEND', -121.00, 110.00, 11.00, 'AUTHORISED', '2031-10-15T00:00:00Z'),
  ('TO-RECV-1', 'TO-BANK', '2031-10-09', 'RECEIVE', 999.00, 999.00, 0, 'AUTHORISED', '2031-10-15T00:00:00Z');

DO $$
DECLARE
  v jsonb;
  m jsonb;
  b jsonb;
  months text[];
BEGIN
  v := public.xero_tieout_monthly('2031-10-15', 7);

  -- The months shown: October back to April, newest first; November is after as_of.
  SELECT array_agg(e ->> 'month' ORDER BY ord) INTO months
    FROM jsonb_array_elements(v -> 'months') WITH ORDINALITY t(e, ord);
  IF months IS DISTINCT FROM ARRAY['2031-10', '2031-09', '2031-08', '2031-07', '2031-06', '2031-05', '2031-04'] THEN
    RAISE EXCEPTION 'months: %', months;
  END IF;
  IF v ->> 'covers' <> 'bills only' OR (v ->> 'complete')::boolean OR (v ->> 'as_of') <> '2031-10-15' THEN
    RAISE EXCEPTION 'header: %', v - 'months';
  END IF;

  -- October: every bucket to the cent, and the parts add up to the total.
  SELECT e INTO m FROM jsonb_array_elements(v -> 'months') e WHERE e ->> 'month' = '2031-10';
  b := m -> 'bills';
  IF (b ->> 'count')::int <> 12 THEN RAISE EXCEPTION 'October count: %', b ->> 'count'; END IF;
  IF (b ->> 'total_ex')::numeric <> 4206.75 OR (m ->> 'tie_out_total_ex')::numeric <> 4206.75 THEN
    RAISE EXCEPTION 'October total_ex: % / %', b ->> 'total_ex', m ->> 'tie_out_total_ex';
  END IF;
  IF (b ->> 'total_inc')::numeric <> 4597.44 THEN RAISE EXCEPTION 'October total_inc: %', b ->> 'total_inc'; END IF;
  IF (b ->> 'on_job_ex')::numeric <> 2300.35 THEN RAISE EXCEPTION 'October on_job_ex: %', b ->> 'on_job_ex'; END IF;
  IF (b -> 'non_job' ->> 'overhead_not_job_related_ex')::numeric <> 280.39 THEN
    RAISE EXCEPTION 'October overhead: %', b -> 'non_job';
  END IF;
  IF (b -> 'non_job' ->> 'trade_app_mirror_ex')::numeric <> 300.00 THEN
    RAISE EXCEPTION 'October mirror: %', b -> 'non_job';
  END IF;
  IF (b ->> 'non_job_ex')::numeric <> 580.39 THEN RAISE EXCEPTION 'October non_job_ex: %', b ->> 'non_job_ex'; END IF;
  IF jsonb_typeof(b -> 'non_job' -> 'stock_ex') <> 'null' OR jsonb_typeof(b -> 'non_job' -> 'vehicles_ex') <> 'null'
     OR b -> 'non_job' ->> 'stock_and_vehicles' <> 'not_yet_separated' THEN
    RAISE EXCEPTION 'October stock and vehicles must be not yet separated, never 0: %', b -> 'non_job';
  END IF;
  IF (b ->> 'unplaced_ex')::numeric <> 1326.01 THEN RAISE EXCEPTION 'October unplaced_ex: %', b ->> 'unplaced_ex'; END IF;
  IF (b ->> 'unplaced_share')::numeric <> 0.3153 THEN RAISE EXCEPTION 'October share: %', b ->> 'unplaced_share'; END IF;
  IF NOT (b ->> 'parts_add_up')::boolean THEN RAISE EXCEPTION 'October parts do not add up: %', b; END IF;
  IF (b -> 'unplaced_by_reason' ->> 'waiting_in_bills_to_place')::numeric <> 500.55
     OR (b -> 'unplaced_by_reason' ->> 'holding_job')::numeric <> 120.00
     OR (b -> 'unplaced_by_reason' ->> 'installer_awaiting_confirmation')::numeric <> 600.00
     OR (b -> 'unplaced_by_reason' ->> 'not_in_intake')::numeric <> 55.46
     OR (b -> 'unplaced_by_reason' ->> 'rows_short_of_bill')::numeric <> 50.00
     OR (b -> 'unplaced_by_reason' ->> 'negative_bill')::numeric <> 0 THEN
    RAISE EXCEPTION 'October reasons: %', b -> 'unplaced_by_reason';
  END IF;
  IF (b -> 'over_allocated' ->> 'bills')::int <> 1 OR (b -> 'over_allocated' ->> 'ex')::numeric <> 50.00 THEN
    RAISE EXCEPTION 'October over allocated: %', b -> 'over_allocated';
  END IF;
  IF (m -> 'not_counted' ->> 'draft_or_submitted_bills')::int <> 1 OR (m -> 'not_counted' ->> 'draft_or_submitted_ex')::numeric <> 77.77 THEN
    RAISE EXCEPTION 'October not counted: %', m -> 'not_counted';
  END IF;

  -- Credit notes and spend: not yet read, null amounts, never 0, never counted.
  IF m -> 'credit_notes' ->> 'status' <> 'not_yet_read' OR jsonb_typeof(m -> 'credit_notes' -> 'amount_ex') <> 'null'
     OR (m -> 'credit_notes' ->> 'counted')::boolean OR m -> 'credit_notes' ->> 'ticket' <> 'TP-07' THEN
    RAISE EXCEPTION 'October credit notes: %', m -> 'credit_notes';
  END IF;
  IF m -> 'spend' ->> 'status' <> 'not_yet_read' OR jsonb_typeof(m -> 'spend' -> 'amount_ex') <> 'null'
     OR (m -> 'spend' ->> 'counted')::boolean OR m -> 'spend' ->> 'ticket' <> 'TP-08' THEN
    RAISE EXCEPTION 'October spend: %', m -> 'spend';
  END IF;
  IF (m -> 'spend' -> 'bank_copy_partial' ->> 'rows')::int <> 1 OR (m -> 'spend' -> 'bank_copy_partial' ->> 'ex')::numeric <> 110.00 THEN
    RAISE EXCEPTION 'October bank copy: %', m -> 'spend';
  END IF;

  -- September: 400 on a job, 100 waiting; no bank copy rows is null, not 0.
  SELECT e INTO m FROM jsonb_array_elements(v -> 'months') e WHERE e ->> 'month' = '2031-09';
  b := m -> 'bills';
  IF (b ->> 'total_ex')::numeric <> 500.00 OR (b ->> 'on_job_ex')::numeric <> 400.00
     OR (b ->> 'unplaced_ex')::numeric <> 100.00 OR (b ->> 'unplaced_share')::numeric <> 0.2 THEN
    RAISE EXCEPTION 'September: %', b;
  END IF;
  IF jsonb_typeof(m -> 'spend' -> 'bank_copy_partial' -> 'ex') <> 'null' THEN
    RAISE EXCEPTION 'September bank copy must be null with no rows: %', m -> 'spend';
  END IF;

  -- A month with no bills: a known 0 total, and no share (never 0%).
  SELECT e INTO m FROM jsonb_array_elements(v -> 'months') e WHERE e ->> 'month' = '2031-08';
  IF (m -> 'bills' ->> 'total_ex')::numeric <> 0 OR jsonb_typeof(m -> 'bills' -> 'unplaced_share') <> 'null' THEN
    RAISE EXCEPTION 'August: %', m -> 'bills';
  END IF;

  -- April is shown but is not in the last 6 months.
  SELECT e INTO m FROM jsonb_array_elements(v -> 'months') e WHERE e ->> 'month' = '2031-04';
  IF (m -> 'bills' ->> 'unplaced_ex')::numeric <> 1000.00 THEN RAISE EXCEPTION 'April: %', m -> 'bills'; END IF;
  IF v -> 'last_6_months' ->> 'from' <> '2031-05-01' OR v -> 'last_6_months' ->> 'to' <> '2031-10-31'
     OR (v -> 'last_6_months' ->> 'bills_total_ex')::numeric <> 4706.75
     OR (v -> 'last_6_months' ->> 'unplaced_ex')::numeric <> 1426.01
     OR (v -> 'last_6_months' ->> 'unplaced_share_of_bills')::numeric <> 0.3030
     OR (v -> 'last_6_months' ->> 'accounted_share_of_bills')::numeric <> 0.6970 THEN
    RAISE EXCEPTION 'last 6 months: %', v -> 'last_6_months';
  END IF;

  -- The last 6 months do not depend on how many months are shown.
  v := public.xero_tieout_monthly('2031-10-15', 1);
  IF jsonb_array_length(v -> 'months') <> 1 OR (v -> 'last_6_months' ->> 'unplaced_ex')::numeric <> 1426.01 THEN
    RAISE EXCEPTION 'one month shown: % %', jsonb_array_length(v -> 'months'), v -> 'last_6_months';
  END IF;

  -- not_yet_read names both missing reads and their tickets.
  IF NOT (v -> 'not_yet_read' @> '[{"part": "supplier_credit_notes", "ticket": "TP-07"}, {"part": "spend_money", "ticket": "TP-08"}]') THEN
    RAISE EXCEPTION 'not_yet_read: %', v -> 'not_yet_read';
  END IF;

  -- Aggregates only: no bill, supplier or job is named anywhere in the read.
  IF v::text ~ '(TO-[A-Z]|TOB-|TO Steel|TO-J1)' THEN RAISE EXCEPTION 'the read names a bill, supplier or job'; END IF;

  -- A placement moves dollars between buckets; the month total never moves.
  UPDATE public.materials_reconciliation_queue SET status = 'not_job_related' WHERE xero_invoice_id = 'TO-OPEN';
  v := public.xero_tieout_monthly('2031-10-15', 1);
  b := v -> 'months' -> 0 -> 'bills';
  IF (b ->> 'total_ex')::numeric <> 4206.75 OR (b ->> 'unplaced_ex')::numeric <> 825.46
     OR (b -> 'non_job' ->> 'overhead_not_job_related_ex')::numeric <> 780.94 OR NOT (b ->> 'parts_add_up')::boolean THEN
    RAISE EXCEPTION 'after filing TO-OPEN: %', b;
  END IF;

  -- A person confirming the installer bill puts it on the job (JP-12).
  INSERT INTO public.job_materials_facts (xero_invoice_id, job_id, job_number, lane, kind, amount_ex_gst, confidence, automation_source, fact_date)
  VALUES ('TO-INST', 'b7000000-0000-4000-8000-000000000001', 'TO-J1', 'labour', 'actual', 600.00, 'high_manual', 'manual_queue', '2031-10-09');
  v := public.xero_tieout_monthly('2031-10-15', 1);
  b := v -> 'months' -> 0 -> 'bills';
  IF (b ->> 'on_job_ex')::numeric <> 2900.35 OR (b -> 'unplaced_by_reason' ->> 'installer_awaiting_confirmation')::numeric <> 0
     OR NOT (b ->> 'parts_add_up')::boolean THEN
    RAISE EXCEPTION 'after confirming TO-INST: %', b;
  END IF;

  -- Service role only.
  IF has_function_privilege('anon', 'public.xero_tieout_monthly(date,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.xero_tieout_monthly(date,integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.xero_tieout_monthly(date,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'xero_tieout_monthly must be service role only';
  END IF;
  -- Read only.
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.xero_tieout_monthly(date,integer)'::regprocedure) <> 's' THEN
    RAISE EXCEPTION 'xero_tieout_monthly must be STABLE';
  END IF;
END $$;

ROLLBACK;
