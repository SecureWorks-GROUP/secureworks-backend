-- 2026-09-11: Xero draft reconciliation must not head-of-line block.
--
-- The hourly stale-receivable reconcile now also verifies a few cached ACCREC
-- drafts by identity once a day. The draft selection is ordered, so a draft
-- whose GET /Invoices/{id} keeps failing stayed first in every run and blocked
-- every row behind it. synced_at cannot record the attempt: it is a
-- verification timestamp and advancing it on a failure would claim a balance
-- was checked when it was not.
--
-- reconcile_attempted_at records the attempt honestly. The draft sweep orders
-- by it (nulls first), so a repeatedly failing row sorts last instead of
-- blocking the queue, and reconcile_last_error keeps the reason visible.
alter table public.xero_invoices
  add column if not exists reconcile_attempted_at timestamptz,
  add column if not exists reconcile_last_error text;

-- The daily draft sweep is gated on a cursor in the existing sync-state table
-- under key 'draft_reconcile_last_run_at'. No new table is needed.
