-- Pre-migration surface for trade invoice time entries.
--
-- public.users, public.jobs, public.job_assignments, public.trade_invoices,
-- public.trade_invoice_lines and persist_weekly_trade_invoice_v1 come from
-- the earlier registered trade invoice cases (20260827112928,
-- 20260831021701, 20260911080000, 20260918120000), and the anon,
-- authenticated and service_role roles from the first registered case.
-- Only feature_flags is restated, in its live shape (read from production
-- information_schema on 12 Oct 2026), in case no earlier case made it.
-- Test infrastructure, not a replacement for the production schema.
CREATE TABLE IF NOT EXISTS public.feature_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_name text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT false,
  description text,
  updated_at timestamptz DEFAULT now()
);

-- This case's own trade and job (the earlier cases' are rolled back with
-- their contracts).
INSERT INTO public.users (id, org_id, name, role) VALUES
  ('f1000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-0000000000aa',
   'Tess Trade (contract)', 'trade');
INSERT INTO public.jobs (id, org_id, status, type, job_number) VALUES
  ('f2000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-0000000000aa',
   'complete', 'fencing', 'SWF-TIME-1');

-- A line saved before the migration: it must come through with no time entry.
INSERT INTO public.trade_invoices (
  id, org_id, user_id, week_start, week_end, status, invoice_source, invoice_number,
  submitted_at, subtotal_ex, gst, total_inc, gst_on, super_rate, super_amount,
  gross_earned, net_pay
) VALUES (
  'f4000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-0000000000aa',
  'f1000000-0000-4000-8000-000000000001', '2026-09-21', '2026-09-27', 'paid', 'hourly',
  'SW-INV-TIME-BEFORE', '2026-09-27T10:00:00Z', 100, 0, 100, false, 0.12, 12, 100, 88
);
INSERT INTO public.trade_invoice_lines (
  id, trade_invoice_id, job_id, job_number, line_type, total_hours, hourly_rate, line_total_ex
) VALUES (
  'f5000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000001',
  'f2000000-0000-4000-8000-000000000001', 'SWF-TIME-1', 'labour', 2.5, 40, 100
);
