-- Executed against disposable PostgreSQL after the full registered stack.
-- Owner call JP-04: work-order pay lines are labour; nothing else moves.
BEGIN;

-- 1. The view's output is the same columns, same order, same base types
--    (precision comes from trade_invoice_lines and cannot drift here).
DO $$
DECLARE
  got text;
  expected text := 'line_id uuid,resolved_job_id uuid,attributed_direct boolean,'
    || 'trade_invoice_id uuid,user_id uuid,week_start date,invoice_status text,'
    || 'xero_bill_id text,line_type text,description text,total_hours numeric,'
    || 'hourly_rate numeric,line_total_ex numeric,line_date date,division text,'
    || 'cost_lane text,match_method text,is_probable_test_line boolean,'
    || 'exclusion_reason text,flag_type text,baseline_hours numeric,'
    || 'baseline_source text,hours_justification text,'
    || 'flagged_at timestamp with time zone,is_hours_flagged boolean';
BEGIN
  SELECT string_agg(a.attname || ' ' || format_type(a.atttypid, NULL), ',' ORDER BY a.attnum)
    INTO got
  FROM pg_attribute a
  WHERE a.attrelid = 'public.v_trade_charge_resolved'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped;
  IF got IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'jp04: v_trade_charge_resolved output columns changed: %', got;
  END IF;
END $$;

INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, created_at) VALUES
  ('a7f00000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001',
   'complete', 'fencing', 'JP04-WO', false, '{}', '2026-08-01T00:00:00Z');

INSERT INTO public.users (id, org_id, name) VALUES
  ('a7f10000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'JP04 Trade');

INSERT INTO public.trade_invoices (id, org_id, user_id, week_start, status, subtotal_ex,
                                   gst_on, gst, total_inc, super_rate, super_amount, gross_earned, net_pay) VALUES
  ('a7f20000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001',
   'a7f10000-0000-4000-8000-000000000001', '2026-08-03', 'approved', 1960,
   false, 0, 1960, 0.12, 235.20, 1960, 1842.40);

-- One line of every lane the view knows, plus the two work-order pay types,
-- a final payout deduction and an unknown type.
INSERT INTO public.trade_invoice_lines (id, trade_invoice_id, job_id, line_type, description, line_total_ex, line_date) VALUES
  ('a7f30000-0000-4000-8000-000000000001', 'a7f20000-0000-4000-8000-000000000001', 'a7f00000-0000-4000-8000-000000000001', 'work order', 'Work order pay', 1000, '2026-08-04'),
  ('a7f30000-0000-4000-8000-000000000002', 'a7f20000-0000-4000-8000-000000000001', 'a7f00000-0000-4000-8000-000000000001', 'work_order', 'Work order pay', 500, '2026-08-04'),
  ('a7f30000-0000-4000-8000-000000000003', 'a7f20000-0000-4000-8000-000000000001', 'a7f00000-0000-4000-8000-000000000001', 'labour', 'Fence labour', 300, '2026-08-04'),
  ('a7f30000-0000-4000-8000-000000000004', 'a7f20000-0000-4000-8000-000000000001', 'a7f00000-0000-4000-8000-000000000001', 'materials', 'Posts', 100, '2026-08-04'),
  ('a7f30000-0000-4000-8000-000000000005', 'a7f20000-0000-4000-8000-000000000001', 'a7f00000-0000-4000-8000-000000000001', 'commission', 'Commission', 50, '2026-08-04'),
  ('a7f30000-0000-4000-8000-000000000006', 'a7f20000-0000-4000-8000-000000000001', 'a7f00000-0000-4000-8000-000000000001', 'travel', 'Travel', 10, '2026-08-04');

-- 2. Every line type lands in the lane it should.
DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT v.line_type, v.expected, r.cost_lane
    FROM (VALUES
      ('work order', 'labour'),
      ('work_order', 'labour'),
      ('labour', 'labour'),
      ('materials', 'materials'),
      ('commission', 'commission'),
      ('travel', 'other')
    ) AS v(line_type, expected)
    LEFT JOIN public.v_trade_charge_resolved r
      ON r.trade_invoice_id = 'a7f20000-0000-4000-8000-000000000001'
     AND r.line_type = v.line_type
  LOOP
    IF rec.cost_lane IS DISTINCT FROM rec.expected THEN
      RAISE EXCEPTION 'jp04: line_type % has cost_lane %, expected %',
        rec.line_type, rec.cost_lane, rec.expected;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.v_trade_charge_resolved
             WHERE trade_invoice_id = 'a7f20000-0000-4000-8000-000000000001'
               AND resolved_job_id IS DISTINCT FROM 'a7f00000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'jp04: a fixture line did not resolve to its job';
  END IF;
END $$;

-- 3. Anything the view does not name still reads unclassified.
DO $$
BEGIN
  INSERT INTO public.trade_invoice_lines (id, trade_invoice_id, job_id, line_type, description, line_total_ex, line_date) VALUES
    ('a7f30000-0000-4000-8000-000000000007', 'a7f20000-0000-4000-8000-000000000001', 'a7f00000-0000-4000-8000-000000000001', 'mystery_pay', 'Unknown', 0, '2026-08-04');
  IF (SELECT cost_lane FROM public.v_trade_charge_resolved
      WHERE line_id = 'a7f30000-0000-4000-8000-000000000007') IS DISTINCT FROM 'unclassified' THEN
    RAISE EXCEPTION 'jp04: an unnamed line type must stay unclassified';
  END IF;
  DELETE FROM public.trade_invoice_lines WHERE id = 'a7f30000-0000-4000-8000-000000000007';
END $$;

-- 4. Business outcome: the job profit engine counts the work-order pay as
-- labour and no longer holds the job back for unclassified lines.
DO $$
DECLARE
  p record;
BEGIN
  SELECT * INTO p FROM public.v_job_profit WHERE job_id = 'a7f00000-0000-4000-8000-000000000001';
  IF p.job_id IS NULL THEN
    RAISE EXCEPTION 'jp04: fixture job missing from v_job_profit';
  END IF;
  IF p.actual_labour_ex IS DISTINCT FROM 1800::numeric THEN
    RAISE EXCEPTION 'jp04: actual labour should be 1000 + 500 + 300 = 1800, got %', p.actual_labour_ex;
  END IF;
  IF p.cost_flag = 'unclassified_lines' OR 'unclassified_lines' = ANY (p.completeness) THEN
    RAISE EXCEPTION 'jp04: work-order pay lines must not hold the job back as unclassified';
  END IF;
END $$;

ROLLBACK;
