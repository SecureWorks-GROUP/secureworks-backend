-- Contract for 20261030170000_job_labour_employer_oncost.
--
-- Synthetic jobs and invoices, no customer or staff data. Everything rolls back.
-- The company super rows are behind job_cost_employer_super_v1: off as
-- released (checked first), then on for the cases below.
--
--   TL-J1, TL-J2  finished fencing jobs.
--   TI-HALF   6/6 split: labour 800 + commission 200 on J1, super 120, net pay
--             940 (worker gave up 60). Payout deductions (ute hire) live on the
--             invoice, never on a line, so no view reads them as job cost.
--             Company super 60: 48 labour, 12 commission.
--   TI-FULL   28 Aug-17 Sep basis: labour 500 on J1, super 60, net 440. The
--             worker paid it all: no company super row.
--   TI-V2     full employer-super group share 813.89 on J1 (line 'group share'),
--             super 97.67, net 813.89. Labour 813.89 + company super 97.67.
--   TI-NONE   no super recorded: labour 300 on J1, no company super row
--             (unknown, never zero).
--   TI-ADV    "Commission Advance" 1,000 (typed labour) + labour 67.50 on J1,
--             super 128.10, net 1,003.45. The advance and its super are lane
--             advance, never actual. Labour 67.50 + company super 4.05.
--   TI-MULTI  labour 300 on J1, 700 on J2, 100 on no job; super 132, net 1,034.
--             Company super 66: 18 on J1, 42 on J2, 6 on no job.
--   TI-REJ    rejected invoice with super: nothing.
--
-- J1 actual labour = 800 + 500 + 813.89 + 300 + 67.50 + 300 (lines)
--                  + 48 + 97.67 + 4.05 + 18 (company super) = 2,949.11.
-- J1 actual commission = 200 + 12 = 212.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, pricing_json, expected_costs, created_at) VALUES
  ('a1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'TL-J1', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z'),
  ('a1000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'TL-J2', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z');

INSERT INTO public.users (id, org_id, name) VALUES
  ('a1200000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'TL Crew');

INSERT INTO public.trade_invoices (id, org_id, user_id, week_start, status, subtotal_ex, gst, total_inc, invoice_number,
                                   gst_on, super_rate, gross_earned, super_amount, net_pay, super_basis,
                                   recurring_deduction_label, recurring_deduction_amount) VALUES
  ('a1100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'a1200000-0000-4000-8000-000000000001',
   '2026-10-19', 'pushed_to_xero', 1000, 0, 1000, 'TI-HALF', false, 0.12, 1000, 120, 940, NULL, NULL, NULL),
  ('a1100000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'a1200000-0000-4000-8000-000000000001',
   '2026-09-01', 'paid', 500, 0, 500, 'TI-FULL', false, 0.12, 500, 60, 440, NULL, NULL, NULL),
  ('a1100000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'a1200000-0000-4000-8000-000000000001',
   NULL, 'approved', 813.89, 0, 813.89, 'TI-V2', false, 0.12, 813.89, 97.67, 813.89, 'employer_12_v2', NULL, NULL),
  ('a1100000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000001', 'a1200000-0000-4000-8000-000000000001',
   '2026-10-19', 'pushed_to_xero', 1067.50, 0, 1067.50, 'TI-ADV', false, 0.12, 1067.50, 128.10, 1003.45, NULL, NULL, NULL),
  ('a1100000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000001', 'a1200000-0000-4000-8000-000000000001',
   '2026-10-19', 'approved', 1100, 0, 1100, 'TI-MULTI', false, 0.12, 1100, 132, 1034, NULL, NULL, NULL),
  ('a1100000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000001', 'a1200000-0000-4000-8000-000000000001',
   '2026-10-19', 'ops-reject', 400, 0, 400, 'TI-REJ', false, 0.12, 400, 48, 376, NULL, NULL, NULL);

-- A July invoice from before super was recorded: the money-split trigger did
-- not exist then, so the row is loaded as a replica write.
SET LOCAL session_replication_role = replica;
INSERT INTO public.trade_invoices (id, org_id, user_id, week_start, status, subtotal_ex, gst, total_inc, invoice_number) VALUES
  ('a1100000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000001', 'a1200000-0000-4000-8000-000000000001',
   '2026-07-06', 'paid', 300, 0, 300, 'TI-NONE');
SET LOCAL session_replication_role = origin;

INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, job_number, line_type, description, total_hours, line_total_ex, line_date) VALUES
  ('a1100000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'TL-J1', 'labour', 'Install', 16, 800, '2026-10-20'),
  ('a1100000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'TL-J1', 'commission', 'Commission TL-J1', 1, 200, '2026-10-20'),
  ('a1100000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001', 'TL-J1', 'labour', 'Install', 10, 500, '2026-09-02'),
  ('a1100000-0000-4000-8000-000000000004', 'a1000000-0000-4000-8000-000000000001', 'TL-J1', 'labour', 'Install', 6, 300, '2026-07-07'),
  ('a1100000-0000-4000-8000-000000000005', 'a1000000-0000-4000-8000-000000000001', 'TL-J1', 'labour', 'Commission Advance', 1, 1000, '2026-10-22'),
  ('a1100000-0000-4000-8000-000000000005', 'a1000000-0000-4000-8000-000000000001', 'TL-J1', 'labour', 'Flashing install', 1.5, 67.50, '2026-10-22'),
  ('a1100000-0000-4000-8000-000000000006', 'a1000000-0000-4000-8000-000000000001', 'TL-J1', 'labour', 'Install', 6, 300, '2026-10-21'),
  ('a1100000-0000-4000-8000-000000000006', 'a1000000-0000-4000-8000-000000000002', 'TL-J2', 'labour', 'Install', 14, 700, '2026-10-22'),
  ('a1100000-0000-4000-8000-000000000006', NULL, NULL, 'labour', 'Yard tidy', 2, 100, '2026-10-23'),
  ('a1100000-0000-4000-8000-000000000007', 'a1000000-0000-4000-8000-000000000001', 'TL-J1', 'labour', 'Install', 8, 400, '2026-10-21');

-- Switch off (as released): no company super row at all.
-- The group share line as the release writes it. Its snapshot trigger needs a
-- whole group; these views read only the line, so it is loaded as a replica write.
SET LOCAL session_replication_role = replica;
INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, job_number, line_type, description, total_hours, line_total_ex, line_date) VALUES
  ('a1100000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000001', 'TL-J1', 'group share', 'Group work order share for TL-J1', 0, 813.89, NULL);
SET LOCAL session_replication_role = origin;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.v_job_cost_events WHERE source = 'trade_employer_super') THEN
    RAISE EXCEPTION 'job labour: company super rows while the switch is off';
  END IF;
END $$;

UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_cost_employer_super_v1';

DO $$
DECLARE
  v numeric;
  n integer;
  r record;
BEGIN
  -- The 6/6 invoice: the company's half only, split by line, in each line's lane.
  SELECT sum(amount_ex) INTO v FROM public.v_job_cost_events
   WHERE source = 'trade_employer_super' AND document_number = 'TI-HALF';
  IF v IS DISTINCT FROM 60 THEN RAISE EXCEPTION 'job labour: company super on the 6/6 invoice (got %)', v; END IF;
  SELECT sum(amount_ex) INTO v FROM public.v_job_cost_events
   WHERE source = 'trade_employer_super' AND document_number = 'TI-HALF' AND lane = 'commission';
  IF v IS DISTINCT FROM 12 THEN RAISE EXCEPTION 'job labour: super on commission stays commission (got %)', v; END IF;

  -- Worker paid it all, or nothing recorded: no company super row at all.
  SELECT count(*) INTO n FROM public.v_job_cost_events
   WHERE source = 'trade_employer_super' AND document_number IN ('TI-FULL', 'TI-NONE', 'TI-REJ');
  IF n <> 0 THEN RAISE EXCEPTION 'job labour: % company super rows where none is owed or known', n; END IF;

  -- The group share is labour, and its super is the company's in full.
  SELECT lane, is_actual INTO r FROM public.v_job_cost_events
   WHERE source = 'trade_line' AND document_number = 'TI-V2';
  IF r.lane IS DISTINCT FROM 'labour' OR r.is_actual IS NOT TRUE THEN
    RAISE EXCEPTION 'job labour: group share lane % actual %', r.lane, r.is_actual;
  END IF;
  SELECT sum(amount_ex) INTO v FROM public.v_job_cost_events
   WHERE source = 'trade_employer_super' AND document_number = 'TI-V2' AND lane = 'labour';
  IF v IS DISTINCT FROM 97.67 THEN RAISE EXCEPTION 'job labour: group share company super (got %)', v; END IF;

  -- The advance and its super are never a job cost.
  SELECT count(*) INTO n FROM public.v_job_cost_events
   WHERE document_number = 'TI-ADV' AND lane = 'advance' AND NOT is_actual;
  IF n <> 2 THEN RAISE EXCEPTION 'job labour: advance rows not held out (%)', n; END IF;
  SELECT count(*) INTO n FROM public.v_job_cost_events
   WHERE document_number = 'TI-ADV' AND lane = 'advance' AND is_actual;
  IF n <> 0 THEN RAISE EXCEPTION 'job labour: an advance counted as actual'; END IF;
  SELECT sum(amount_ex) INTO v FROM public.v_job_cost_events
   WHERE source = 'trade_employer_super' AND document_number = 'TI-ADV' AND lane = 'labour';
  IF v IS DISTINCT FROM 4.05 THEN RAISE EXCEPTION 'job labour: super on the labour beside an advance (got %)', v; END IF;

  -- One invoice over two jobs: the super follows each line; the no-job line's
  -- share lands on no job.
  SELECT sum(amount_ex) INTO v FROM public.v_job_cost_events
   WHERE source = 'trade_employer_super' AND document_number = 'TI-MULTI' AND job_id = 'a1000000-0000-4000-8000-000000000001';
  IF v IS DISTINCT FROM 18 THEN RAISE EXCEPTION 'job labour: multi-job super on J1 (got %)', v; END IF;
  SELECT sum(amount_ex) INTO v FROM public.v_job_cost_events
   WHERE source = 'trade_employer_super' AND document_number = 'TI-MULTI' AND job_id = 'a1000000-0000-4000-8000-000000000002';
  IF v IS DISTINCT FROM 42 THEN RAISE EXCEPTION 'job labour: multi-job super on J2 (got %)', v; END IF;

  -- Company super is paid to the fund separately: never marked paid here.
  IF EXISTS (SELECT 1 FROM public.v_job_cost_events WHERE source = 'trade_employer_super' AND paid) THEN
    RAISE EXCEPTION 'job labour: company super marked paid';
  END IF;

  -- Payout deductions and the worker's own super never reduce job cost.
  IF EXISTS (SELECT 1 FROM public.v_job_cost_events
              WHERE job_id IN ('a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002')
                AND amount_ex < 0) THEN
    RAISE EXCEPTION 'job labour: a deduction reduced job cost';
  END IF;

  -- The trade line rows are unchanged: gross, once.
  SELECT sum(amount_ex) INTO v FROM public.v_job_cost_events
   WHERE source = 'trade_line' AND is_actual AND job_id = 'a1000000-0000-4000-8000-000000000001';
  IF v IS DISTINCT FROM 2981.39 THEN RAISE EXCEPTION 'job labour: J1 trade lines (got %)', v; END IF;

  -- Job Profit reads it: labour and commission on J1.
  SELECT actual_labour_ex, actual_commission_ex INTO r FROM public.v_job_profit
   WHERE job_id = 'a1000000-0000-4000-8000-000000000001';
  IF NOT FOUND THEN RAISE EXCEPTION 'job labour: J1 missing from v_job_profit'; END IF;
  IF r.actual_labour_ex IS DISTINCT FROM 2949.11 THEN
    RAISE EXCEPTION 'job labour: J1 labour in v_job_profit (got %)', r.actual_labour_ex;
  END IF;
  IF r.actual_commission_ex IS DISTINCT FROM 212 THEN
    RAISE EXCEPTION 'job labour: J1 commission in v_job_profit (got %)', r.actual_commission_ex;
  END IF;

  -- The resolver: group share is labour, the advance its own lane.
  SELECT count(*) INTO n FROM public.v_trade_charge_resolved
   WHERE line_type = 'group share' AND cost_lane = 'labour'
     AND trade_invoice_id = 'a1100000-0000-4000-8000-000000000003';
  IF n <> 1 THEN RAISE EXCEPTION 'job labour: resolver group share lane'; END IF;
  SELECT count(*) INTO n FROM public.v_trade_charge_resolved
   WHERE cost_lane = 'advance' AND trade_invoice_id = 'a1100000-0000-4000-8000-000000000005';
  IF n <> 1 THEN RAISE EXCEPTION 'job labour: resolver advance lane'; END IF;

  IF has_table_privilege('anon', 'public.v_job_cost_events', 'SELECT')
     OR has_table_privilege('authenticated', 'public.v_trade_charge_resolved', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.v_job_cost_events', 'SELECT') THEN
    RAISE EXCEPTION 'job labour: grants changed';
  END IF;
END $$;

ROLLBACK;
