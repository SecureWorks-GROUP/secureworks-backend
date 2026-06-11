-- ════════════════════════════════════════════════════════════════════════════
-- Trade invoicing fix — DB guards for PR1
-- Mission: trade-invoicing-fix-2026-06-11
--
-- Adds:
--   1. trade_invoices.status 'ops-reject'  — terminal status for a reviewed
--      invoice that ops rejects, so its assignments are released and the partial
--      unique index excludes it.                                       [D6]
--   2. job_assignments.invoiced_in uuid     — assignment-level double-invoice
--      guard (Layer B). Set when an assignment lands on a non-failed invoice;
--      myHours() hides assignments whose referencing invoice is still live.  [F3]
--
-- NOTE: the partial UNIQUE index on (user_id, week_start) is created by the
-- STAGED PR0 SQL (pr0-rate-repair-staged.sql STEP 11) AFTER the live Alyx
-- duplicate is resolved and Hugo's Sunday key is normalised. It is intentionally
-- NOT created here — building it before the prod data is clean would fail.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Add 'ops-reject' to the trade_invoices.status CHECK ──────────────────
-- Existing allowed set (from 20260325000003_timer_invoice_system.sql):
--   draft, pending_acknowledgment, queried, acknowledged,
--   pending_ops_review, approved, pushed_to_xero, paid
-- We add 'ops-reject'. Drop + re-add the named constraint idempotently.
DO $$
DECLARE
  con_name text;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'trade_invoices'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%pending_ops_review%'
  LIMIT 1;

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE trade_invoices DROP CONSTRAINT %I', con_name);
  END IF;

  ALTER TABLE trade_invoices
    ADD CONSTRAINT trade_invoices_status_check
    CHECK (status IN (
      'draft', 'pending_acknowledgment', 'queried', 'acknowledged',
      'pending_ops_review', 'approved', 'pushed_to_xero', 'paid', 'ops-reject'
    ));
END $$;

-- ── 2. Assignment-level double-invoice guard (Layer B) ──────────────────────
ALTER TABLE job_assignments
  ADD COLUMN IF NOT EXISTS invoiced_in uuid REFERENCES trade_invoices(id);

-- Partial index for the myHours() "hide already-invoiced assignment" filter.
CREATE INDEX IF NOT EXISTS idx_job_assignments_invoiced_in
  ON job_assignments(invoiced_in)
  WHERE invoiced_in IS NOT NULL;

COMMENT ON COLUMN job_assignments.invoiced_in IS
  'When this assignment is included on a non-failed trade_invoice, references that '
  'invoice. myHours() hides assignments whose referencing invoice status is NOT IN '
  '(draft, failed, ops-reject), preventing double-invoicing across weeks. Released '
  '(left dangling but ignored) when the invoice moves to a terminal failed/reject state.';
