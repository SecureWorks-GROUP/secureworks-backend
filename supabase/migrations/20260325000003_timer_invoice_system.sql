-- ════════════════════════════════════════════════════════════
-- Server-Side Timer + Weekly Trade Invoice System
--
-- Phase 1: Clock columns on job_assignments (server truth)
-- Phase 2: trade_invoices + trade_invoice_lines (weekly contractor invoicing)
-- Phase 3: User profile fields (ABN, rate, payment terms)
-- ════════════════════════════════════════════════════════════

-- ── Phase 1: Clock columns on job_assignments ──
-- These are the SERVER source of truth for clock times.
-- localStorage in trade app is a cache only.

ALTER TABLE job_assignments ADD COLUMN IF NOT EXISTS clocked_on_at timestamptz;
ALTER TABLE job_assignments ADD COLUMN IF NOT EXISTS clocked_off_at timestamptz;
ALTER TABLE job_assignments ADD COLUMN IF NOT EXISTS travel_started_at timestamptz;
ALTER TABLE job_assignments ADD COLUMN IF NOT EXISTS arrived_at timestamptz;
ALTER TABLE job_assignments ADD COLUMN IF NOT EXISTS break_minutes integer DEFAULT 0;
ALTER TABLE job_assignments ADD COLUMN IF NOT EXISTS hours_worked numeric(6,2);
ALTER TABLE job_assignments ADD COLUMN IF NOT EXISTS hourly_rate numeric(8,2);
ALTER TABLE job_assignments ADD COLUMN IF NOT EXISTS manual_override_flag boolean DEFAULT false;

-- Index for "currently on site" queries (ops dashboard live indicator)
CREATE INDEX IF NOT EXISTS idx_assignments_active_clock
  ON job_assignments(clocked_on_at)
  WHERE clocked_on_at IS NOT NULL AND clocked_off_at IS NULL;

-- ── Phase 2: Weekly trade invoices ──
-- Drop old trade_invoices if it exists with wrong schema (from earlier build)
DROP TABLE IF EXISTS trade_invoice_lines CASCADE;
DROP TABLE IF EXISTS trade_invoices CASCADE;

CREATE TABLE trade_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  user_id uuid NOT NULL REFERENCES users(id),
  week_start date NOT NULL,
  week_end date NOT NULL,

  -- Aggregated totals
  total_hours numeric(6,2) NOT NULL,
  total_breaks_minutes integer NOT NULL DEFAULT 0,
  subtotal_ex numeric(10,2) NOT NULL,
  gst numeric(10,2) NOT NULL,
  total_inc numeric(10,2) NOT NULL,

  -- Status flow: draft → pending_acknowledgment → (queried ↔ pending_acknowledgment) → acknowledged → (pending_ops_review → approved) → pushed_to_xero → paid
  status text NOT NULL DEFAULT 'pending_acknowledgment'
    CHECK (status IN ('draft', 'pending_acknowledgment', 'queried', 'acknowledged', 'pending_ops_review', 'approved', 'pushed_to_xero', 'paid')),

  -- Flags
  has_manual_overrides boolean DEFAULT false,
  override_details jsonb,

  -- Xero
  xero_bill_id text,
  xero_pushed_at timestamptz,

  -- Metadata
  submitted_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  queried_at timestamptz,
  query_note text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trade_inv_user ON trade_invoices(user_id, week_start);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_inv_unique ON trade_invoices(user_id, week_start);

COMMENT ON TABLE trade_invoices IS
  'Weekly contractor invoices generated from clock data. One per trade per week. '
  'Approval flow: Tier 1 → lead trade acknowledges. Tier 2 → auto if within WO, ops review if over.';

-- ── Per-job line items on weekly invoice ──

CREATE TABLE trade_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_invoice_id uuid NOT NULL REFERENCES trade_invoices(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id),
  job_number text,
  client_name text,

  -- Hours for this job this week
  total_hours numeric(6,2) NOT NULL,
  hourly_rate numeric(8,2) NOT NULL,
  line_total_ex numeric(10,2) NOT NULL,

  -- Reference
  work_order_hours numeric(6,2),
  days_worked integer,
  assignment_ids uuid[],

  -- Per-line acknowledgment (different jobs may have different leads)
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  acknowledgment_status text DEFAULT 'pending'
    CHECK (acknowledgment_status IN ('pending', 'acknowledged', 'queried')),
  query_note text,

  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inv_lines_invoice ON trade_invoice_lines(trade_invoice_id);
CREATE INDEX IF NOT EXISTS idx_inv_lines_job ON trade_invoice_lines(job_id);

COMMENT ON TABLE trade_invoice_lines IS
  'Per-job line items on a weekly trade invoice. Each line shows total hours on one job for the week. '
  'Acknowledgment is per-line because different jobs may have different lead trades.';

-- ── Phase 3: User profile fields ──

ALTER TABLE users ADD COLUMN IF NOT EXISTS abn text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS default_hourly_rate numeric(8,2);
ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_terms_days integer DEFAULT 7;
