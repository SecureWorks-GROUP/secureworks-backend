-- Contract for 20261115140000_trade_pay_run_check: every stop and note fires on the case it
-- names and on no other, a clean invoice stays clean, drafts, rejected invoices, other weeks and
-- other orgs are left out, the week count is clamped, and only the service role may call it.

\echo == trade pay-run check: shape and grants ==
DO $$
DECLARE fn regprocedure := 'public.trade_pay_run_check(date,integer,uuid)'::regprocedure;
BEGIN
  IF (SELECT provolatile FROM pg_proc WHERE oid = fn) <> 's' THEN
    RAISE EXCEPTION 'trade pay-run check must be STABLE (read only)';
  END IF;
  IF has_function_privilege('anon', fn, 'EXECUTE') OR has_function_privilege('authenticated', fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'trade pay-run check must not be callable by anon or authenticated';
  END IF;
  IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'trade pay-run check must be callable by the service role';
  END IF;
  IF COALESCE(obj_description(fn, 'pg_proc'), '') NOT LIKE 'Trade pay-run check, rule trade-pay-check-v1 (20261115140000)%' THEN
    RAISE EXCEPTION 'trade pay-run check comment is missing its rule name';
  END IF;
END $$;

\echo == trade pay-run check: fixtures and verdicts ==
BEGIN;

-- Earlier registered cases may hang foreign keys, NOT NULL columns, checks and triggers on these
-- tables. None of them is what this contract is about, so they are lifted inside this transaction.
DO $$
DECLARE t text; c record;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'trade_invoices', 'trade_invoice_lines', 'work_orders', 'trade_rates', 'job_assignments'] LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER USER', t);
    FOR c IN SELECT conname FROM pg_constraint
             WHERE conrelid = format('public.%I', t)::regclass AND contype IN ('f', 'c', 'u', 'x') LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, c.conname);
    END LOOP;
    FOR c IN SELECT a.attname FROM pg_attribute a
             WHERE a.attrelid = format('public.%I', t)::regclass AND a.attnum > 0 AND NOT a.attisdropped
               AND a.attnotnull AND a.attname <> 'id' LOOP
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP NOT NULL', t, c.attname);
    END LOOP;
  END LOOP;
END $$;

-- Org A and B; one trade per case.
INSERT INTO public.users (id, name) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'Clean Trade'),
  ('00000000-0000-0000-0000-0000000000a2', 'No Bill'),
  ('00000000-0000-0000-0000-0000000000a3', 'Voided'),
  ('00000000-0000-0000-0000-0000000000a4', 'Gst Missing'),
  ('00000000-0000-0000-0000-0000000000a5', 'Deduction'),
  ('00000000-0000-0000-0000-0000000000a6', 'Wo One'),
  ('00000000-0000-0000-0000-0000000000a7', 'Wo Two'),
  ('00000000-0000-0000-0000-0000000000a8', 'Labour Over'),
  ('00000000-0000-0000-0000-0000000000a9', 'Rate Off'),
  ('00000000-0000-0000-0000-0000000000b0', 'Booking Rate'),
  ('00000000-0000-0000-0000-0000000000b1', 'No Job'),
  ('00000000-0000-0000-0000-0000000000b2', 'Twice'),
  ('00000000-0000-0000-0000-0000000000b3', 'Long Day'),
  ('00000000-0000-0000-0000-0000000000b4', 'Unbooked'),
  ('00000000-0000-0000-0000-0000000000b5', 'Other Org'),
  ('00000000-0000-0000-0000-0000000000b6', 'Low Rate'),
  ('00000000-0000-0000-0000-0000000000b7', 'Total Unread'),
  ('00000000-0000-0000-0000-0000000000b8', 'Bill Raised'),
  ('00000000-0000-0000-0000-0000000000b9', 'Line Edited'),
  ('00000000-0000-0000-0000-0000000000c0', 'No Agreed'),
  ('00000000-0000-0000-0000-0000000000c1', 'Make Safe'),
  ('00000000-0000-0000-0000-0000000000c2', 'Crew Share'),
  ('00000000-0000-0000-0000-0000000000c3', 'Tuesday Week'),
  ('00000000-0000-0000-0000-0000000000c4', 'Reissued'),
  ('00000000-0000-0000-0000-0000000000c5', 'Next Week');

INSERT INTO public.trade_rates (user_id, hourly_rate, effective_from, effective_to) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 50, '2026-01-01', NULL),
  ('00000000-0000-0000-0000-0000000000a8', 50, '2026-01-01', NULL),
  ('00000000-0000-0000-0000-0000000000a9', 40, '2026-01-01', '2026-10-31'),
  ('00000000-0000-0000-0000-0000000000a9', 50, '2026-11-01', NULL),
  ('00000000-0000-0000-0000-0000000000b0', 50, '2026-01-01', NULL),
  ('00000000-0000-0000-0000-0000000000b4', 50, '2026-01-01', NULL),
  ('00000000-0000-0000-0000-0000000000b6', 50, '2026-01-01', NULL),
  ('00000000-0000-0000-0000-0000000000c1', 50, '2026-01-01', NULL);

INSERT INTO public.work_orders (id, agreed_labour_ex) VALUES
  ('00000000-0000-0000-0000-00000000c001', 800),
  ('00000000-0000-0000-0000-00000000c002', 1000),
  ('00000000-0000-0000-0000-00000000c003', 500),
  ('00000000-0000-0000-0000-00000000c004', 800);

INSERT INTO public.job_assignments (user_id, job_id, status, scheduled_date, scheduled_end, hourly_rate) VALUES
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000d001', 'confirmed', '2026-11-10', NULL, NULL),
  ('00000000-0000-0000-0000-0000000000a9', '00000000-0000-0000-0000-00000000d001', 'confirmed', '2026-11-09', '2026-11-13', NULL),
  ('00000000-0000-0000-0000-0000000000b0', '00000000-0000-0000-0000-00000000d002', 'confirmed', '2026-11-11', NULL, 70),
  ('00000000-0000-0000-0000-0000000000b6', '00000000-0000-0000-0000-00000000d007', 'confirmed', '2026-11-10', NULL, NULL),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000d008', 'confirmed', '2026-11-12', NULL, NULL),
  -- a cancelled booking does not count as booked
  ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-00000000d003', 'cancelled', '2026-11-12', NULL, NULL);

-- org_id: A = ...e001, B = ...e002. Week under test: 9 Nov 2026 (and 2 Nov for the second trade
-- on the over-billed work order).
INSERT INTO public.trade_invoices (id, org_id, user_id, week_start, status, invoice_number, invoice_source,
                                   gst_on, gst, net_pay, recurring_deduction_amount, xero_adjustments_ex,
                                   xero_bill_id, xero_bill_status, xero_bill_total) VALUES
  ('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000a1', '2026-11-09', 'pushed_to_xero', 'INV-1',  'hourly', false, 0,   1000, NULL, 0,   'x1',  'DRAFT',    1000),
  ('00000000-0000-0000-0000-0000000f0002', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000a2', '2026-11-09', 'pending_acknowledgment', 'INV-2', 'hourly', false, 0, 400, NULL, 0, NULL, NULL, NULL),
  ('00000000-0000-0000-0000-0000000f0003', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000a3', '2026-11-09', 'pushed_to_xero', 'INV-3',  'hourly', false, 0,   300,  NULL, 0,   'x3',  'VOIDED',   300),
  ('00000000-0000-0000-0000-0000000f0004', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000a4', '2026-11-09', 'pushed_to_xero', 'INV-4',  'hourly', true,  100, 900,  NULL, 0,   'x4',  'DRAFT',    900),
  ('00000000-0000-0000-0000-0000000f0005', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000a5', '2026-11-09', 'paid',           'INV-5',  'hourly', false, 0,   500,  100,  -50, 'x5',  'PAID',     350),
  ('00000000-0000-0000-0000-0000000f0006', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000a6', '2026-11-02', 'paid',           'INV-6',  'hourly', false, 0,   800,  NULL, 0,   'x6',  'PAID',     800),
  ('00000000-0000-0000-0000-0000000f0007', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000a7', '2026-11-09', 'pushed_to_xero', 'INV-7',  'hourly', false, 0,   800,  NULL, 0,   'x7',  'DRAFT',    800),
  ('00000000-0000-0000-0000-0000000f0008', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000a8', '2026-11-09', 'pushed_to_xero', 'INV-8',  'hourly', false, 0,   1200, NULL, 0,   'x8',  'DRAFT',    1200),
  ('00000000-0000-0000-0000-0000000f0009', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000a9', '2026-11-09', 'pushed_to_xero', 'INV-9',  'hourly', false, 0,   600,  NULL, 0,   'x9',  'DRAFT',    600),
  ('00000000-0000-0000-0000-0000000f0010', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000b0', '2026-11-09', 'pushed_to_xero', 'INV-10', 'hourly', false, 0,   700,  NULL, 0,   'x10', 'DRAFT',    700),
  ('00000000-0000-0000-0000-0000000f0011', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000b1', '2026-11-09', 'pushed_to_xero', 'INV-11', 'hourly', false, 0,   200,  NULL, 0,   'x11', 'DRAFT',    200),
  ('00000000-0000-0000-0000-0000000f0012', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000b2', '2026-11-09', 'pushed_to_xero', 'INV-12', 'hourly', false, 0,   100,  NULL, 0,   'x12', 'DRAFT',    100),
  ('00000000-0000-0000-0000-0000000f0013', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000b2', '2026-11-09', 'pushed_to_xero', 'INV-13', 'hourly', false, 0,   150,  NULL, 0,   'x13', 'DRAFT',    150),
  ('00000000-0000-0000-0000-0000000f0014', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000b3', '2026-11-09', 'pushed_to_xero', 'INV-14', 'hourly', false, 0,   500,  NULL, 0,   'x14', 'DRAFT',    500),
  ('00000000-0000-0000-0000-0000000f0015', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000b4', '2026-11-09', 'pushed_to_xero', 'INV-15', 'hourly', false, 0,   400,  NULL, 0,   'x15', 'DRAFT',    400),
  -- a trade's own rate below the office rate passes (owner, 15 Nov 2026)
  ('00000000-0000-0000-0000-0000000f0020', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000b6', '2026-11-09', 'pushed_to_xero', 'INV-20', 'hourly', false, 0,   360,  NULL, 0,   'x20', 'DRAFT',    360),
  -- left out: a draft, a rejected invoice, an older week, another org
  ('00000000-0000-0000-0000-0000000f0016', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000b2', '2026-11-09', 'draft',          'INV-16', 'hourly', false, 0,   50,   NULL, 0,   NULL,  NULL,       NULL),
  ('00000000-0000-0000-0000-0000000f0017', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000a1', '2026-11-09', 'ops-reject',     'INV-17', 'hourly', false, 0,   50,   NULL, 0,   NULL,  NULL,       NULL),
  ('00000000-0000-0000-0000-0000000f0018', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000a1', '2026-10-26', 'paid',           'INV-18', 'hourly', false, 0,   50,   NULL, 0,   'x18', 'PAID',     50),
  ('00000000-0000-0000-0000-0000000f0019', '00000000-0000-0000-0000-00000000e002', '00000000-0000-0000-0000-0000000000b5', '2026-11-09', 'pushed_to_xero', 'INV-19', 'hourly', false, 0,   75,   NULL, 0,   NULL,  NULL,       NULL);

-- Review findings, 15 Nov 2026: a bill whose total was never read, a bill raised by hand in Xero,
-- an invoice line edited in Xero, a work order with nothing agreed, make-safe labour, a crew share
-- (no week_start; its 12% super sits inside the share, so it is above the agreed $500 and is not
-- stopped for it), a non-Monday week_start, a reissue beside its voided bill, and a week after.
INSERT INTO public.trade_invoices (id, org_id, user_id, week_start, status, invoice_number, invoice_source,
                                   gst_on, gst, net_pay, recurring_deduction_amount, xero_adjustments_ex,
                                   xero_adjustment_lines, xero_bill_id, xero_bill_status, xero_bill_total,
                                   submitted_at, created_at) VALUES
  ('00000000-0000-0000-0000-0000000f0021', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000b7', '2026-11-09', 'pushed_to_xero', 'INV-21', 'hourly', false, 0, 300,  NULL, NULL, NULL, 'x21', 'DRAFT', NULL, NULL, NULL),
  ('00000000-0000-0000-0000-0000000f0022', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000b8', '2026-11-09', 'pushed_to_xero', 'INV-22', 'hourly', false, 0, 1000, NULL, 500,
     '[{"kind":"office_line","amount":500}]'::jsonb, 'x22', 'DRAFT', 1500, NULL, NULL),
  ('00000000-0000-0000-0000-0000000f0023', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000b9', '2026-11-09', 'pushed_to_xero', 'INV-23', 'hourly', false, 0, 400,  NULL, 0,
     '[{"kind":"unexplained","amount":0}]'::jsonb, 'x23', 'DRAFT', 400, NULL, NULL),
  ('00000000-0000-0000-0000-0000000f0024', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000c0', '2026-11-09', 'pushed_to_xero', 'INV-24', 'hourly', false, 0, 5000, NULL, 0, NULL, 'x24', 'DRAFT', 5000, NULL, NULL),
  ('00000000-0000-0000-0000-0000000f0025', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000c1', '2026-11-09', 'pushed_to_xero', 'INV-25', 'hourly', false, 0, 720,  NULL, 0, NULL, 'x25', 'DRAFT', 720, NULL, NULL),
  ('00000000-0000-0000-0000-0000000f0026', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000c2', NULL,         'paid',           'INV-26', 'hourly', false, 0, 560,  NULL, 0, NULL, 'x26', 'PAID',  560, '2026-11-11T02:00:00Z', '2026-11-11T02:00:00Z'),
  ('00000000-0000-0000-0000-0000000f0027', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000c3', '2026-11-10', 'pushed_to_xero', 'INV-27', 'hourly', false, 0, 250,  NULL, 0, NULL, 'x27', 'DRAFT', 250, NULL, NULL),
  ('00000000-0000-0000-0000-0000000f0028', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000c4', '2026-11-09', 'pushed_to_xero', 'INV-28', 'hourly', false, 0, 800,  NULL, 0, NULL, 'x28', 'VOIDED', 800, NULL, NULL),
  ('00000000-0000-0000-0000-0000000f0029', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000c4', '2026-11-09', 'pushed_to_xero', 'INV-29', 'hourly', false, 0, 800,  NULL, 0, NULL, 'x29', 'DRAFT', 800, NULL, NULL),
  ('00000000-0000-0000-0000-0000000f0030', '00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000c5', '2026-11-16', 'pushed_to_xero', 'INV-30', 'hourly', false, 0, 100,  NULL, 0, NULL, NULL,  NULL,    NULL, NULL, NULL);

INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, job_number, line_type, line_total_ex, hourly_rate,
                                        total_hours, baseline_hours, flag_type, work_date, job_work_order_id) VALUES
  ('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-00000000d001', 'SWF-1', 'labour',     1000, 50, 20, NULL, NULL, '2026-11-10', NULL),
  ('00000000-0000-0000-0000-0000000f0004', '00000000-0000-0000-0000-00000000d001', 'SWF-1', 'commission', 1000, NULL, NULL, NULL, NULL, NULL, NULL),
  ('00000000-0000-0000-0000-0000000f0006', '00000000-0000-0000-0000-00000000d004', 'SWF-4', 'work order', 800,  NULL, NULL, NULL, NULL, NULL, '00000000-0000-0000-0000-00000000c001'),
  ('00000000-0000-0000-0000-0000000f0007', '00000000-0000-0000-0000-00000000d004', 'SWF-4', 'work order', 800,  NULL, NULL, NULL, NULL, NULL, '00000000-0000-0000-0000-00000000c001'),
  ('00000000-0000-0000-0000-0000000f0008', '00000000-0000-0000-0000-00000000d005', 'SWF-5', 'work order', 600,  NULL, NULL, NULL, NULL, NULL, '00000000-0000-0000-0000-00000000c002'),
  ('00000000-0000-0000-0000-0000000f0008', '00000000-0000-0000-0000-00000000d005', 'SWF-5', 'labour',     600,  50, 12, NULL, NULL, NULL, '00000000-0000-0000-0000-00000000c002'),
  ('00000000-0000-0000-0000-0000000f0009', '00000000-0000-0000-0000-00000000d001', 'SWF-1', 'labour',     600,  60, 10, NULL, NULL, '2026-11-11', NULL),
  ('00000000-0000-0000-0000-0000000f0010', '00000000-0000-0000-0000-00000000d002', 'SWF-2', 'labour',     700,  70, 10, NULL, NULL, '2026-11-11', NULL),
  ('00000000-0000-0000-0000-0000000f0011', NULL,                                   NULL,    'labour',     200,  NULL, 4, NULL, NULL, NULL, NULL),
  ('00000000-0000-0000-0000-0000000f0014', '00000000-0000-0000-0000-00000000d006', 'SWF-6', 'labour',     500,  NULL, 10, 6, 'hours_over_baseline', NULL, NULL),
  ('00000000-0000-0000-0000-0000000f0015', '00000000-0000-0000-0000-00000000d003', 'SWF-3', 'labour',     400,  50, 8, NULL, NULL, '2026-11-12', NULL),
  ('00000000-0000-0000-0000-0000000f0020', '00000000-0000-0000-0000-00000000d007', 'SWF-7', 'labour',     360,  45, 8, NULL, NULL, '2026-11-10', NULL),
  ('00000000-0000-0000-0000-0000000f0024', '00000000-0000-0000-0000-00000000d009', 'SWF-9', 'work order', 5000, NULL, NULL, NULL, NULL, NULL, NULL),
  ('00000000-0000-0000-0000-0000000f0025', '00000000-0000-0000-0000-00000000d008', 'SWMS-8', 'make safe', 720,  90, 8, NULL, NULL, '2026-11-12', NULL),
  ('00000000-0000-0000-0000-0000000f0026', '00000000-0000-0000-0000-00000000d010', 'SWP-10', 'group share', 560, NULL, NULL, NULL, NULL, NULL, '00000000-0000-0000-0000-00000000c003'),
  ('00000000-0000-0000-0000-0000000f0028', '00000000-0000-0000-0000-00000000d011', 'SWF-11', 'work order', 800,  NULL, NULL, NULL, NULL, NULL, '00000000-0000-0000-0000-00000000c004'),
  ('00000000-0000-0000-0000-0000000f0029', '00000000-0000-0000-0000-00000000d011', 'SWF-11', 'work order', 800,  NULL, NULL, NULL, NULL, NULL, '00000000-0000-0000-0000-00000000c004');

CREATE TEMP TABLE pay_check ON COMMIT DROP AS
  SELECT public.trade_pay_run_check('2026-11-15'::date, 2, NULL) AS r;
CREATE TEMP TABLE pay_rows ON COMMIT DROP AS
  SELECT e->>'invoice_number' AS inv, e->>'verdict' AS verdict, (e->>'paid')::boolean AS paid,
         ARRAY(SELECT s->>'code' FROM jsonb_array_elements(e->'stops') s ORDER BY 1) AS stops,
         ARRAY(SELECT s->>'code' FROM jsonb_array_elements(e->'notes') s ORDER BY 1) AS notes,
         e
  FROM pay_check, jsonb_array_elements(r->'invoices') e;

DO $$
DECLARE
  r jsonb := (SELECT r FROM pay_check);
  want record;
  got record;
BEGIN
  IF r->>'rule' <> 'trade-pay-check-v1' OR r->>'from_week' <> '2026-11-02' OR r->>'to_week' <> '2026-11-09' THEN
    RAISE EXCEPTION 'pay check header wrong: %', r - 'invoices';
  END IF;
  IF (SELECT count(*) FROM pay_rows) <> 26 THEN
    RAISE EXCEPTION 'pay check should list 26 invoices (no draft, rejected, older week), got %: %',
      (SELECT count(*) FROM pay_rows), (SELECT array_agg(inv ORDER BY inv) FROM pay_rows);
  END IF;

  FOR want IN SELECT * FROM (VALUES
      ('INV-1',  'clean',   ARRAY[]::text[],                                ARRAY[]::text[]),
      ('INV-2',  'stopped', ARRAY['not_in_xero'],                           ARRAY[]::text[]),
      ('INV-3',  'stopped', ARRAY['xero_bill_voided'],                      ARRAY[]::text[]),
      ('INV-4',  'stopped', ARRAY['xero_amount_differs'],                   ARRAY[]::text[]),
      ('INV-5',  'clean',   ARRAY[]::text[],                                ARRAY['changed_in_xero']),
      ('INV-6',  'stopped', ARRAY['work_order_over_agreed'],                ARRAY[]::text[]),
      ('INV-7',  'stopped', ARRAY['work_order_over_agreed'],                ARRAY[]::text[]),
      ('INV-8',  'clean',   ARRAY[]::text[],                                ARRAY['labour_over_agreed']),
      ('INV-9',  'stopped', ARRAY['rate_above_office'],                     ARRAY[]::text[]),
      ('INV-10', 'clean',   ARRAY[]::text[],                                ARRAY[]::text[]),
      ('INV-11', 'stopped', ARRAY['line_on_no_job'],                        ARRAY[]::text[]),
      ('INV-12', 'stopped', ARRAY['second_invoice_same_week'],              ARRAY[]::text[]),
      ('INV-13', 'stopped', ARRAY['second_invoice_same_week'],              ARRAY[]::text[]),
      ('INV-14', 'clean',   ARRAY[]::text[],                                ARRAY['hours_over_expected']),
      ('INV-15', 'clean',   ARRAY[]::text[],                                ARRAY['day_not_booked']),
      ('INV-19', 'stopped', ARRAY['not_in_xero'],                           ARRAY[]::text[]),
      ('INV-20', 'clean',   ARRAY[]::text[],                                ARRAY[]::text[]),
      ('INV-21', 'stopped', ARRAY['xero_total_not_read'],                   ARRAY[]::text[]),
      ('INV-22', 'stopped', ARRAY['xero_changed_by_hand'],                  ARRAY[]::text[]),
      ('INV-23', 'stopped', ARRAY['xero_changed_by_hand'],                  ARRAY[]::text[]),
      ('INV-24', 'stopped', ARRAY['work_order_not_agreed'],                 ARRAY[]::text[]),
      ('INV-25', 'stopped', ARRAY['rate_above_office'],                     ARRAY[]::text[]),
      ('INV-26', 'clean',   ARRAY[]::text[],                                ARRAY[]::text[]),
      ('INV-27', 'clean',   ARRAY[]::text[],                                ARRAY[]::text[]),
      ('INV-28', 'stopped', ARRAY['second_invoice_same_week', 'xero_bill_voided'], ARRAY[]::text[]),
      ('INV-29', 'clean',   ARRAY[]::text[],                                ARRAY[]::text[])
    ) AS v(inv, verdict, stops, notes) LOOP
    SELECT * INTO got FROM pay_rows WHERE pay_rows.inv = want.inv;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pay check: % missing', want.inv;
    END IF;
    IF got.verdict <> want.verdict OR got.stops <> want.stops OR got.notes <> want.notes THEN
      RAISE EXCEPTION 'pay check: % expected % stops % notes %, got % stops % notes %',
        want.inv, want.verdict, want.stops, want.notes, got.verdict, got.stops, got.notes;
    END IF;
  END LOOP;

  -- Words, and the figure the stop names.
  IF (SELECT e->'stops'->0->>'text' FROM pay_rows WHERE inv = 'INV-4')
       <> 'The Xero bill is $900.00, and the invoice pays $1,000.00.' THEN
    RAISE EXCEPTION 'pay check: GST stop words wrong: %', (SELECT e->'stops' FROM pay_rows WHERE inv = 'INV-4');
  END IF;
  IF (SELECT e->'stops'->0->>'text' FROM pay_rows WHERE inv = 'INV-7')
       <> 'The work order on SWF-4 is billed $1,600.00 by 2 trades, and $800.00 was agreed.' THEN
    RAISE EXCEPTION 'pay check: work order stop words wrong: %', (SELECT e->'stops' FROM pay_rows WHERE inv = 'INV-7');
  END IF;
  IF (SELECT e->'stops'->0->>'text' FROM pay_rows WHERE inv = 'INV-9')
       <> 'The rate on SWF-1 is $60.00 an hour, above the office rate of $50.00.' THEN
    RAISE EXCEPTION 'pay check: rate stop must use the rate on the day worked: %', (SELECT e->'stops' FROM pay_rows WHERE inv = 'INV-9');
  END IF;
  IF (SELECT e->'stops'->0->>'text' FROM pay_rows WHERE inv = 'INV-22')
       <> 'The Xero bill was changed by hand to pay $500.00 more.'
     OR (SELECT e->'stops'->0->>'text' FROM pay_rows WHERE inv = 'INV-23')
       <> 'A line from the invoice was changed by hand in Xero.' THEN
    RAISE EXCEPTION 'pay check: changed-by-hand words wrong: %, %',
      (SELECT e->'stops' FROM pay_rows WHERE inv = 'INV-22'), (SELECT e->'stops' FROM pay_rows WHERE inv = 'INV-23');
  END IF;
  IF (SELECT e->'notes'->0->>'text' FROM pay_rows WHERE inv = 'INV-5')
       <> 'The office changed the bill in Xero by -$50.00.' THEN
    RAISE EXCEPTION 'pay check: a negative change must read -$50.00: %', (SELECT e->'notes' FROM pay_rows WHERE inv = 'INV-5');
  END IF;
  -- A crew share counts in the Perth week it was sent; a Tuesday week_start stays in its week.
  IF (SELECT e->>'week_start' FROM pay_rows WHERE inv = 'INV-26') <> '2026-11-09'
     OR NOT (SELECT paid FROM pay_rows WHERE inv = 'INV-26') THEN
    RAISE EXCEPTION 'pay check: crew share week or paid wrong: %', (SELECT e FROM pay_rows WHERE inv = 'INV-26');
  END IF;
  IF EXISTS (SELECT 1 FROM pay_rows WHERE inv = 'INV-30') THEN
    RAISE EXCEPTION 'pay check: an invoice for the week after as_of must be left out';
  END IF;
  IF (SELECT (e->>'invoice_pays')::numeric FROM pay_rows WHERE inv = 'INV-5') <> 350 THEN
    RAISE EXCEPTION 'pay check: invoice_pays must take off the deduction and add the Xero lines';
  END IF;

  -- Counts and order: unpaid stopped first, then unpaid clean, then paid.
  IF r->'counts' <> jsonb_build_object('invoices', 26, 'clean', 10, 'stopped', 16, 'to_pay', 23,
                                       'to_pay_clean', 8, 'to_pay_stopped', 15) THEN
    RAISE EXCEPTION 'pay check counts wrong: %', r->'counts';
  END IF;
  IF (r->'invoices'->0->>'verdict') <> 'stopped' OR (r->'invoices'->0->>'paid')::boolean
     OR NOT (r->'invoices'->25->>'paid')::boolean THEN
    RAISE EXCEPTION 'pay check order wrong: unpaid stopped first, paid last';
  END IF;

  -- Org scope and the week clamp.
  IF (SELECT jsonb_array_length(public.trade_pay_run_check('2026-11-15', 2, '00000000-0000-0000-0000-00000000e002')->'invoices')) <> 1 THEN
    RAISE EXCEPTION 'pay check: org B must see only its own invoice';
  END IF;
  IF (public.trade_pay_run_check('2026-11-15', 0, NULL)->>'weeks')::int <> 1
     OR (public.trade_pay_run_check('2026-11-15', 500, NULL)->>'weeks')::int <> 26 THEN
    RAISE EXCEPTION 'pay check: weeks must be clamped to 1..26';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(public.trade_pay_run_check('2026-11-15', 1, NULL)->'invoices') e
      WHERE (e->>'week_start')::date NOT BETWEEN '2026-11-09' AND '2026-11-15') <> 0 THEN
    RAISE EXCEPTION 'pay check: one week must read only the week of as_of';
  END IF;
END $$;

ROLLBACK;
