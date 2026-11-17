-- P1-01.5: Job Profit counts a new-rule invoice once, at its total.
--
-- A new-rule invoice withholds all of its super, so the job cost views read
-- company super as super_amount - (subtotal_ex - net_pay) = 0 and add no
-- trade_employer_super row. An old-rule invoice still adds the company's half.
-- Made-up ZZTEST records; rolled back. Changes no view or function.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, pricing_json, expected_costs, created_at) VALUES
  ('f1170000-0000-4000-8000-000000000301', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'ZZTEST-JP-NEW', false, '{}', '{}', NULL, '2026-12-01T00:00:00Z'),
  ('f1170000-0000-4000-8000-000000000302', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'ZZTEST-JP-OLD', false, '{}', '{}', NULL, '2026-11-01T00:00:00Z');

INSERT INTO public.users (id, org_id, name) VALUES
  ('f1170000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000001', 'ZZTEST Crew JP');

INSERT INTO public.trade_invoices (id, org_id, user_id, week_start, status, subtotal_ex, gst, total_inc, invoice_number,
                                   gst_on, super_rate, gross_earned, super_amount, net_pay, super_basis) VALUES
  ('f1170000-0000-4000-8000-000000000311', '00000000-0000-0000-0000-000000000001', 'f1170000-0000-4000-8000-00000000000b',
   '2026-12-07', 'pushed_to_xero', 1120.00, 0, 1120.00, 'ZZTEST-JP-NEW', false, 0.12, 1120.00, 120.00, 1000.00, 'inclusive_12_112_v1'),
  ('f1170000-0000-4000-8000-000000000312', '00000000-0000-0000-0000-000000000001', 'f1170000-0000-4000-8000-00000000000b',
   '2026-11-02', 'pushed_to_xero', 1000.00, 0, 1000.00, 'ZZTEST-JP-OLD', false, 0.12, 1000.00, 120.00, 940.00, NULL);

INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, job_number, line_type, description, total_hours, line_total_ex, line_date) VALUES
  ('f1170000-0000-4000-8000-000000000311', 'f1170000-0000-4000-8000-000000000301', 'ZZTEST-JP-NEW', 'labour', 'ZZTEST install', 0, 1120.00, '2026-12-08'),
  ('f1170000-0000-4000-8000-000000000312', 'f1170000-0000-4000-8000-000000000302', 'ZZTEST-JP-OLD', 'labour', 'ZZTEST install', 0, 1000.00, '2026-11-03');

UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_cost_employer_super_v1';

DO $$
DECLARE
  n integer;
  v numeric;
  r record;
BEGIN
  -- New rule: one actual labour row of 1,120.00 and no company super row.
  SELECT count(*), sum(amount_ex) INTO n, v FROM public.v_job_cost_events
   WHERE job_id = 'f1170000-0000-4000-8000-000000000301' AND is_actual;
  IF n <> 1 OR v IS DISTINCT FROM 1120.00 THEN
    RAISE EXCEPTION 'job profit: new-rule invoice gives % actual rows totalling %', n, v;
  END IF;
  SELECT lane, source INTO r FROM public.v_job_cost_events
   WHERE job_id = 'f1170000-0000-4000-8000-000000000301' AND is_actual;
  IF r.lane IS DISTINCT FROM 'labour' OR r.source IS DISTINCT FROM 'trade_line' THEN
    RAISE EXCEPTION 'job profit: new-rule row is lane % source %', r.lane, r.source;
  END IF;
  IF EXISTS (SELECT 1 FROM public.v_job_cost_events
             WHERE source = 'trade_employer_super' AND document_number = 'ZZTEST-JP-NEW') THEN
    RAISE EXCEPTION 'job profit: a company super row on a new-rule invoice';
  END IF;

  -- Old rule: labour 1,000.00 plus one company super row of 60.00.
  SELECT sum(amount_ex) INTO v FROM public.v_job_cost_events
   WHERE job_id = 'f1170000-0000-4000-8000-000000000302' AND is_actual AND source = 'trade_line' AND lane = 'labour';
  IF v IS DISTINCT FROM 1000.00 THEN RAISE EXCEPTION 'job profit: old-rule labour (got %)', v; END IF;
  SELECT count(*), sum(amount_ex) INTO n, v FROM public.v_job_cost_events
   WHERE source = 'trade_employer_super' AND document_number = 'ZZTEST-JP-OLD';
  IF n <> 1 OR v IS DISTINCT FROM 60.00 THEN
    RAISE EXCEPTION 'job profit: old-rule company super % rows totalling %', n, v;
  END IF;
END $$;

ROLLBACK;
