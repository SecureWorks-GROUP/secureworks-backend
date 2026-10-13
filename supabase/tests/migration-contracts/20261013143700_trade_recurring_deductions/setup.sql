-- Pre-migration surface for trade recurring deductions.
--
-- public.users, public.jobs, public.trade_invoices, public.trade_invoice_lines
-- and persist_weekly_trade_invoice_v1 / v2 come from the earlier registered
-- trade invoice cases (20260827112928, 20260831021701, 20260918120000,
-- 20261012180000), and the anon, authenticated and service_role roles from
-- the first registered case. Only users.email is added: the live users table
-- has it and the earlier fixtures did not need it.
-- Test infrastructure, not a replacement for the production schema.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS email text;

-- The trade the migration names (by the login email this repository records
-- for him, in mixed case here: the seed must not depend on case) and another
-- trade, who must come through with nothing.
INSERT INTO public.users (id, org_id, name, role, email) VALUES
  ('1de0c710-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-0000000000aa',
   'Ute Trade (contract)', 'lead_installer', 'Isaac.B3lch3r@gmail.com'),
  ('1de0c710-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-0000000000aa',
   'Other Trade (contract)', 'trade', 'other.trade@example.invalid');

-- An invoice of his saved before the migration: it must come through with no
-- deduction and no note. Its pay is the older full carve-out (880, as the
-- earlier trade invoice cases seed theirs), which both the live split CHECK
-- and the old one the 20260918120000 break proof restores accept.
INSERT INTO public.trade_invoices (
  id, org_id, user_id, week_start, week_end, status, invoice_source, invoice_number,
  submitted_at, subtotal_ex, gst, total_inc, gst_on, super_rate, super_amount,
  gross_earned, net_pay
) VALUES (
  '2de0c710-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-0000000000aa',
  '1de0c710-0000-4000-8000-000000000001', '2026-10-05', '2026-10-11', 'paid', 'hourly',
  'SW-INV-UTE-BEFORE', '2026-10-11T10:00:00Z', 1000, 0, 1000, false, 0.12, 120, 1000, 880
);
