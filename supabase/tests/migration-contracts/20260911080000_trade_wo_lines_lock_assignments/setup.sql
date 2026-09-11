-- Minimal pre-migration surface for the Work Order / Commission line lock
-- backfill. public.jobs, public.users, public.work_orders, public.trade_invoices,
-- public.trade_invoice_lines, public.job_assignments and public.business_events
-- come from earlier registered fixtures and migrations. Production types, read
-- from the migrations on main:
--   job_assignments.scheduled_date  date   (20250301000001_schema.sql)
--   job_assignments.role            text   (20250301000001_schema.sql)
--   job_assignments.invoiced_in     uuid   (20260611000001_trade_invoice_guards.sql)
--   trade_invoices.week_start/end   date   (20260325000003_timer_invoice_system.sql)
--   trade_invoice_lines.line_type   text   (20260401000001_invoice_extras.sql)
--   trade_invoice_lines.line_date   date   (20260401000002_invoice_line_date.sql)
--   business_events.job_id          uuid   (production, see the deposit fixture)
-- Test infrastructure, not a replacement for the production schema.

ALTER TABLE public.job_assignments
  ADD COLUMN IF NOT EXISTS scheduled_date date,
  ADD COLUMN IF NOT EXISTS role text;

-- Fixtures the backfill acts on, written BEFORE it runs because a one-off pass
-- can only be observed against pre-existing rows.
INSERT INTO public.users (id, org_id, name, role) VALUES
  ('2f00f91e-8b76-4856-8dec-ab6041f04e1d', 'e0000000-0000-4000-8000-0000000000aa', 'Alyx (contract)', 'trade'),
  ('e1000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-0000000000aa', 'Other trade (contract)', 'trade');

INSERT INTO public.jobs (id, org_id, status, type, job_number) VALUES
  ('e2000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000aa', 'complete', 'fencing', 'SWF-WOLOCK-261063'),
  ('e2000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-0000000000aa', 'complete', 'fencing', 'SWF-WOLOCK-RELEASED'),
  ('e2000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-0000000000aa', 'complete', 'patio', 'SWP-WOLOCK-COMMISSION'),
  ('e2000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-0000000000aa', 'complete', 'fencing', 'SWF-WOLOCK-WEEKLY'),
  ('e2000000-0000-4000-8000-000000000005', 'e0000000-0000-4000-8000-0000000000aa', 'complete', 'fencing', 'SWF-WOLOCK-LABOUR'),
  -- non-week commission line carrying NO line_date: no window can be derived
  ('e2000000-0000-4000-8000-000000000006', 'e0000000-0000-4000-8000-0000000000aa', 'complete', 'patio', 'SWP-WOLOCK-NODATE'),
  -- weekly work-order TRAVEL scope line: reimburses a cost, bills no work
  ('e2000000-0000-4000-8000-000000000007', 'e0000000-0000-4000-8000-0000000000aa', 'complete', 'fencing', 'SWF-WOLOCK-TRAVEL');

INSERT INTO public.work_orders (id, org_id, job_id, status, scheduled_date) VALUES
  ('e3000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-0000000000aa',
   'e2000000-0000-4000-8000-000000000004', 'complete', '2026-09-02');

-- Money columns satisfy trade_invoices_super_gst_split_check and the
-- require-money-split trigger (20260827112928); the weekly row satisfies
-- trade_invoices_weekly_totals_check (20260831021701).
INSERT INTO public.trade_invoices (
  id, org_id, user_id, week_start, week_end, status, invoice_source, invoice_number,
  submitted_at, subtotal_ex, gst, total_inc, gst_on, super_rate, super_amount,
  gross_earned, net_pay, job_grand_total_ex, final_deductions_total_ex, to_be_paid_ex
) VALUES
  -- the Alyx case: PAID weekly invoice whose Work Order line billed the job
  ('e4000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000aa',
   '2f00f91e-8b76-4856-8dec-ab6041f04e1d', '2026-08-24', '2026-08-30', 'paid', 'hourly',
   'SW-INV-A-260830-025', '2026-08-30T10:00:00Z', 1000, 0, 1000, false, 0.12, 120, 1000, 880,
   NULL, NULL, NULL),
  -- a different live invoice that already holds one of Alyx's cards
  ('e4000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-0000000000aa',
   '2f00f91e-8b76-4856-8dec-ab6041f04e1d', NULL, NULL, 'pushed_to_xero', 'misc',
   'SW-INV-A-WOLOCK-HELD', '2026-08-27T10:00:00Z', 1000, 0, 1000, false, 0.12, 120, 1000, 880,
   NULL, NULL, NULL),
  -- released: ops rejected
  ('e4000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-0000000000aa',
   '2f00f91e-8b76-4856-8dec-ab6041f04e1d', '2026-08-17', '2026-08-23', 'ops-reject', 'hourly',
   'SW-INV-A-WOLOCK-REJECT', '2026-08-23T10:00:00Z', 1000, 0, 1000, false, 0.12, 120, 1000, 880,
   NULL, NULL, NULL),
  -- released: still a draft
  ('e4000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-0000000000aa',
   '2f00f91e-8b76-4856-8dec-ab6041f04e1d', '2026-09-07', '2026-09-13', 'draft', 'hourly',
   'SW-INV-A-WOLOCK-DRAFT', NULL, 1000, 0, 1000, false, 0.12, 120, 1000, 880,
   NULL, NULL, NULL),
  -- live non-week invoice with a Commission line
  ('e4000000-0000-4000-8000-000000000005', 'e0000000-0000-4000-8000-0000000000aa',
   '2f00f91e-8b76-4856-8dec-ab6041f04e1d', NULL, NULL, 'pushed_to_xero', 'misc',
   'SW-INV-A-WOLOCK-COMMISSION', '2026-09-01T10:00:00Z', 1000, 0, 1000, false, 0.12, 120, 1000, 880,
   NULL, NULL, NULL),
  -- live weekly work-order invoice
  ('e4000000-0000-4000-8000-000000000006', 'e0000000-0000-4000-8000-0000000000aa',
   '2f00f91e-8b76-4856-8dec-ab6041f04e1d', '2026-08-31', '2026-09-06', 'pending_acknowledgment',
   'weekly_work_order', 'SW-INV-A-WOLOCK-WEEKLY', '2026-09-06T10:00:00Z',
   800, 0, 800, false, 0.12, 96, 800, 704, 800, 0, 800),
  -- live non-week invoice whose Commission line carries no line_date
  ('e4000000-0000-4000-8000-000000000007', 'e0000000-0000-4000-8000-0000000000aa',
   '2f00f91e-8b76-4856-8dec-ab6041f04e1d', NULL, NULL, 'pushed_to_xero', 'misc',
   'SW-INV-A-WOLOCK-NODATE', '2026-09-01T10:00:00Z', 1000, 0, 1000, false, 0.12, 120, 1000, 880,
   NULL, NULL, NULL);

INSERT INTO public.trade_invoice_lines (
  trade_invoice_id, job_id, job_number, line_type, description, line_total_ex, line_date, source_work_order_id
) VALUES
  ('e4000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'SWF-WOLOCK-261063',
   'work order', 'Work order $1477.00. Less labour: Sonny 14.5h x $35 = $507.50. Net payable $969.50', 969.50,
   '2026-08-24', NULL),
  -- an hours line on the same paid invoice: its cards travel via assignment_ids, never this pass
  ('e4000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000005', 'SWF-WOLOCK-LABOUR',
   'labour', 'Labour', 30.50, '2026-08-25', NULL),
  ('e4000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-000000000002', 'SWF-WOLOCK-RELEASED',
   'work order', 'Work order rejected by ops', 500, '2026-08-18', NULL),
  ('e4000000-0000-4000-8000-000000000004', 'e2000000-0000-4000-8000-000000000002', 'SWF-WOLOCK-RELEASED',
   'commission', 'Commission on a draft', 500, '2026-09-08', NULL),
  -- the non-week window case: this line is dated 2026-08-20, so the invoice may
  -- only lock cards on 2026-08-20. It must NOT reach back to 2026-07-01.
  ('e4000000-0000-4000-8000-000000000005', 'e2000000-0000-4000-8000-000000000003', 'SWP-WOLOCK-COMMISSION',
   'commission', 'Commission - SWP-WOLOCK-COMMISSION', 1000, '2026-08-20', NULL),
  ('e4000000-0000-4000-8000-000000000006', 'e2000000-0000-4000-8000-000000000004', 'SWF-WOLOCK-WEEKLY',
   'labour', 'Install 20m fence', 850, '2026-09-02', 'e3000000-0000-4000-8000-000000000004'),
  -- a weekly crew deduction on another job moves money, it does not bill that job
  ('e4000000-0000-4000-8000-000000000006', 'e2000000-0000-4000-8000-000000000002', 'SWF-WOLOCK-RELEASED',
   'crew_work_order_deduction', 'Less: crew charge', -50, '2026-09-02',
   'e3000000-0000-4000-8000-000000000004'),
  -- a weekly work-order TRAVEL scope line: reimburses a cost, bills no work,
  -- so it must never consume the lead installer's day card
  ('e4000000-0000-4000-8000-000000000006', 'e2000000-0000-4000-8000-000000000007', 'SWF-WOLOCK-TRAVEL',
   'travel', 'Travel and disposal', 0, '2026-09-02', 'e3000000-0000-4000-8000-000000000004'),
  -- non-week commission line with NO line_date: no window, so it locks nothing
  ('e4000000-0000-4000-8000-000000000007', 'e2000000-0000-4000-8000-000000000006', 'SWP-WOLOCK-NODATE',
   'commission', 'Commission with no line date', 1000, NULL, NULL);

INSERT INTO public.job_assignments (id, job_id, user_id, status, scheduled_date, role, invoiced_in) VALUES
  -- Alyx's lead_installer card on the paid Work Order job, inside the week
  ('a4019f76-8b8c-4c7e-86bd-8ae0758e8635', 'e2000000-0000-4000-8000-000000000001',
   '2f00f91e-8b76-4856-8dec-ab6041f04e1d', 'complete', '2026-08-24', 'lead_installer', NULL),
  -- another trade's card on the same job and week
  ('e5000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001',
   'e1000000-0000-4000-8000-000000000002', 'complete', '2026-08-25', 'helper', NULL),
  -- Alyx's card already held by another live invoice
  ('e5000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-000000000001',
   '2f00f91e-8b76-4856-8dec-ab6041f04e1d', 'complete', '2026-08-26', 'lead_installer',
   'e4000000-0000-4000-8000-000000000002'),
  -- Alyx's card on the paid job but outside the invoice week
  ('e5000000-0000-4000-8000-000000000004', 'e2000000-0000-4000-8000-000000000001',
   '2f00f91e-8b76-4856-8dec-ab6041f04e1d', 'scheduled', '2026-09-05', 'lead_installer', NULL),
  -- cards behind released invoices
  ('e5000000-0000-4000-8000-000000000005', 'e2000000-0000-4000-8000-000000000002',
   '2f00f91e-8b76-4856-8dec-ab6041f04e1d', 'complete', '2026-08-18', 'lead_installer', NULL),
  ('e5000000-0000-4000-8000-000000000006', 'e2000000-0000-4000-8000-000000000002',
   '2f00f91e-8b76-4856-8dec-ab6041f04e1d', 'complete', '2026-09-08', 'lead_installer', NULL),
  -- non-week Commission invoice: a past card, and a card scheduled after submission
  ('e5000000-0000-4000-8000-000000000007', 'e2000000-0000-4000-8000-000000000003',
   '2f00f91e-8b76-4856-8dec-ab6041f04e1d', 'complete', '2026-08-20', 'lead_installer', NULL),
  ('e5000000-0000-4000-8000-000000000008', 'e2000000-0000-4000-8000-000000000003',
   '2f00f91e-8b76-4856-8dec-ab6041f04e1d', 'scheduled', '2026-10-01', 'lead_installer', NULL),
  -- weekly work-order invoice: the in-week card on the WO job
  ('e5000000-0000-4000-8000-000000000009', 'e2000000-0000-4000-8000-000000000004',
   '2f00f91e-8b76-4856-8dec-ab6041f04e1d', 'complete', '2026-09-02', 'lead_installer', NULL),
  -- in-week card on the job that only carries a deduction line
  ('e5000000-0000-4000-8000-000000000010', 'e2000000-0000-4000-8000-000000000002',
   '2f00f91e-8b76-4856-8dec-ab6041f04e1d', 'complete', '2026-09-02', 'lead_installer', NULL),
  -- card on the job billed only by an hours line
  ('e5000000-0000-4000-8000-000000000011', 'e2000000-0000-4000-8000-000000000005',
   '2f00f91e-8b76-4856-8dec-ab6041f04e1d', 'complete', '2026-08-25', 'lead_installer', NULL),
  -- an earlier unbilled day card on the commission job, weeks before the line it
  -- is billed under. The $1000 commission must NOT swallow it.
  ('e5000000-0000-4000-8000-000000000012', 'e2000000-0000-4000-8000-000000000003',
   '2f00f91e-8b76-4856-8dec-ab6041f04e1d', 'complete', '2026-07-01', 'lead_installer', NULL),
  -- a card on the job whose only billing line carries no line_date
  ('e5000000-0000-4000-8000-000000000013', 'e2000000-0000-4000-8000-000000000006',
   '2f00f91e-8b76-4856-8dec-ab6041f04e1d', 'complete', '2026-08-20', 'lead_installer', NULL),
  -- an in-week card on the job billed only by a weekly travel scope line
  ('e5000000-0000-4000-8000-000000000014', 'e2000000-0000-4000-8000-000000000007',
   '2f00f91e-8b76-4856-8dec-ab6041f04e1d', 'complete', '2026-09-02', 'lead_installer', NULL);
