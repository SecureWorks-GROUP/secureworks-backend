-- ════════════════════════════════════════════════════════════
-- Clear Debt — Payment Chase & Collection System
--
-- Adds:
--   1. payment_chase_logs table for tracking chase interactions
--   2. Debt classification columns on xero_invoices
-- ════════════════════════════════════════════════════════════

-- ── Payment chase activity log ──
CREATE TABLE IF NOT EXISTS payment_chase_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  xero_invoice_id text,
  job_id uuid REFERENCES jobs(id),
  ghl_contact_id text,
  contact_name text,
  method text NOT NULL CHECK (method IN ('call','sms','auto_sms','email','note','status_change')),
  outcome text,
  notes text,
  follow_up_date date,
  follow_up_resolved boolean DEFAULT false,
  chased_by text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chase_logs_invoice ON payment_chase_logs(xero_invoice_id);
CREATE INDEX IF NOT EXISTS idx_chase_logs_followup ON payment_chase_logs(follow_up_date) WHERE follow_up_resolved = false;
CREATE INDEX IF NOT EXISTS idx_chase_logs_job ON payment_chase_logs(job_id);

COMMENT ON TABLE payment_chase_logs IS 'Payment collection activity log for the Clear Debt workflow. Each row = one chase interaction (call, SMS, note, classification change).';
COMMENT ON COLUMN payment_chase_logs.chased_by IS 'Operator email — matches existing ops pattern (text, not FK to users).';
COMMENT ON COLUMN payment_chase_logs.method IS 'call=phone call, sms=manual SMS, auto_sms=GHL workflow SMS, email=email, note=internal note, status_change=classification change.';

-- ── Debt classification on xero_invoices ──
ALTER TABLE xero_invoices ADD COLUMN IF NOT EXISTS debt_classification text
  DEFAULT 'unclassified';

-- Add CHECK constraint separately (IF NOT EXISTS not supported for constraints — use DO block)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'xero_invoices_debt_classification_check'
  ) THEN
    ALTER TABLE xero_invoices ADD CONSTRAINT xero_invoices_debt_classification_check
      CHECK (debt_classification IN ('unclassified','genuine_debt','blocked_by_us','in_dispute','bad_debt'));
  END IF;
END $$;

ALTER TABLE xero_invoices ADD COLUMN IF NOT EXISTS debt_classification_reason text;
ALTER TABLE xero_invoices ADD COLUMN IF NOT EXISTS debt_classified_by text;
ALTER TABLE xero_invoices ADD COLUMN IF NOT EXISTS debt_classified_at timestamptz;
