-- ============================================================
-- SPINE INFRASTRUCTURE — Phase 1 shared schema
-- 4 new tables, 3 ALTER TABLEs, seed data, variation data migration
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. EXPENSE RECEIPTS — receipt photo + AI extraction + approval
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expense_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  job_id uuid REFERENCES jobs(id),
  po_id uuid REFERENCES purchase_orders(id),
  submitted_by uuid REFERENCES users(id),

  -- Receipt data (from Haiku vision extraction)
  vendor_name text,
  receipt_date date,
  total_amount numeric(12,2),
  gst_amount numeric(12,2),
  line_items jsonb DEFAULT '[]',
  extraction_confidence numeric(4,3),
  extraction_raw jsonb,

  -- Matching
  match_type text NOT NULL DEFAULT 'unmatched',
  -- 'po_matched', 'ad_hoc', 'non_job', 'unmatched'
  match_confidence numeric(4,3),

  -- Approval routing: Shaun for job expenses, Jan for stock/general
  status text NOT NULL DEFAULT 'pending',
  -- 'pending', 'pending_extraction', 'approved', 'queried', 'pushed_to_xero'
  approved_by uuid,
  approved_at timestamptz,
  approval_routed_to text,
  -- 'shaun' (job expense), 'jan' (general stock)
  xero_bill_id text,

  -- Media
  receipt_photo_url text NOT NULL,

  -- Tier classification
  expense_tier text NOT NULL DEFAULT 'tier_2',
  -- 'tier_1' (PO-matched), 'tier_2' (ad-hoc job), 'tier_3' (non-job/stock)

  -- Split allocation for bulk purchases across jobs
  split_allocation jsonb DEFAULT NULL,
  -- Format: [{"job_id": "uuid", "amount": 100}, {"job_id": null, "amount": 140, "cost_centre": "general_stock"}]

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expense_receipts_job ON expense_receipts(job_id);
CREATE INDEX IF NOT EXISTS idx_expense_receipts_status ON expense_receipts(status);
CREATE INDEX IF NOT EXISTS idx_expense_receipts_po ON expense_receipts(po_id);
CREATE INDEX IF NOT EXISTS idx_expense_receipts_submitted ON expense_receipts(submitted_by);

ALTER TABLE expense_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role manages expenses" ON expense_receipts FOR ALL USING (auth.role() = 'service_role');


-- ────────────────────────────────────────────────────────────
-- 2. COUNCIL SUBMISSIONS — flexible step-based process tracking
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS council_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  job_id uuid NOT NULL REFERENCES jobs(id),

  -- Flexible step tracking
  steps jsonb NOT NULL DEFAULT '[]',
  -- Format: [{
  --   "step_id": "uuid",
  --   "name": "Get Engineering",
  --   "status": "pending|in_progress|complete|blocked",
  --   "vendor": "Perth Structural Engineers",
  --   "vendor_email": "info@pse.com.au",
  --   "started_at": null,
  --   "completed_at": null,
  --   "documents_received": [],
  --   "notes": ""
  -- }]

  current_step_index int DEFAULT 0,
  overall_status text NOT NULL DEFAULT 'not_started',
  -- 'not_started', 'in_progress', 'complete', 'blocked'

  -- Template used to seed steps
  template_type text,
  -- 'standard_council', 'development_approval', 'retrospective', 'custom'

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_council_submissions_job ON council_submissions(job_id);
CREATE INDEX IF NOT EXISTS idx_council_submissions_status ON council_submissions(overall_status);

ALTER TABLE council_submissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role manages council" ON council_submissions FOR ALL USING (auth.role() = 'service_role');


-- ────────────────────────────────────────────────────────────
-- 3. JOB VARIATIONS — dedicated table (replaces job_events pattern)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_variations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  job_id uuid NOT NULL REFERENCES jobs(id),
  variation_number int NOT NULL DEFAULT 1,

  -- Description
  description text NOT NULL,
  reason text,
  -- 'client_request', 'site_condition', 'design_change', 'error_correction'

  -- Pricing
  amount numeric(12,2) NOT NULL DEFAULT 0,
  gst_included boolean DEFAULT true,
  cost_estimate numeric(12,2),
  photo_url text,

  -- Approval
  status text NOT NULL DEFAULT 'pending_approval',
  -- 'pending_approval', 'approved', 'rejected', 'auto_approved', 'sent', 'accepted', 'declined', 'invoiced'
  needs_approval boolean DEFAULT true,
  share_token text UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  sent_at timestamptz,
  accepted_at timestamptz,
  declined_at timestamptz,
  decline_reason text,

  -- Invoicing
  invoice_method text DEFAULT 'with_final',
  -- 'standalone', 'with_final'
  xero_invoice_id text,

  -- Who
  created_by uuid REFERENCES users(id),
  approved_by uuid,
  approved_at timestamptz,
  approval_notes text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_variations_job ON job_variations(job_id);
CREATE INDEX IF NOT EXISTS idx_variations_status ON job_variations(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_variations_job_number ON job_variations(job_id, variation_number);

ALTER TABLE job_variations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role manages variations" ON job_variations FOR ALL USING (auth.role() = 'service_role');


-- ────────────────────────────────────────────────────────────
-- 4. JOB DURATION DEFAULTS — fallback for when scope_json
--    doesn't have labour_days
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_duration_defaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  job_type text NOT NULL,
  stage_from text NOT NULL,
  stage_to text NOT NULL,
  expected_days int NOT NULL,
  learned_avg_days numeric(6,1),
  sample_count int DEFAULT 0,

  UNIQUE(org_id, job_type, stage_from, stage_to)
);

ALTER TABLE job_duration_defaults ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role manages durations" ON job_duration_defaults FOR ALL USING (auth.role() = 'service_role');

-- Seed with reasonable defaults for Perth construction
INSERT INTO job_duration_defaults (org_id, job_type, stage_from, stage_to, expected_days) VALUES
  ('00000000-0000-0000-0000-000000000001', 'patio', 'quoted', 'accepted', 7),
  ('00000000-0000-0000-0000-000000000001', 'patio', 'accepted', 'deposit_paid', 3),
  ('00000000-0000-0000-0000-000000000001', 'patio', 'deposit_paid', 'materials_ordered', 1),
  ('00000000-0000-0000-0000-000000000001', 'patio', 'materials_ordered', 'materials_delivered', 7),
  ('00000000-0000-0000-0000-000000000001', 'patio', 'materials_delivered', 'install_start', 3),
  ('00000000-0000-0000-0000-000000000001', 'patio', 'install_start', 'completed', 3),
  ('00000000-0000-0000-0000-000000000001', 'patio', 'completed', 'invoiced', 0),
  ('00000000-0000-0000-0000-000000000001', 'patio', 'invoiced', 'paid', 14),
  ('00000000-0000-0000-0000-000000000001', 'fencing', 'quoted', 'accepted', 5),
  ('00000000-0000-0000-0000-000000000001', 'fencing', 'accepted', 'deposit_paid', 3),
  ('00000000-0000-0000-0000-000000000001', 'fencing', 'deposit_paid', 'materials_ordered', 1),
  ('00000000-0000-0000-0000-000000000001', 'fencing', 'materials_ordered', 'materials_delivered', 5),
  ('00000000-0000-0000-0000-000000000001', 'fencing', 'materials_delivered', 'install_start', 2),
  ('00000000-0000-0000-0000-000000000001', 'fencing', 'install_start', 'completed', 2),
  ('00000000-0000-0000-0000-000000000001', 'fencing', 'completed', 'invoiced', 0),
  ('00000000-0000-0000-0000-000000000001', 'fencing', 'invoiced', 'paid', 14)
ON CONFLICT (org_id, job_type, stage_from, stage_to) DO NOTHING;


-- ────────────────────────────────────────────────────────────
-- 5. ALTER EXISTING TABLES
-- ────────────────────────────────────────────────────────────

-- po_communications: add communication_type for council/engineering routing
ALTER TABLE po_communications ADD COLUMN IF NOT EXISTS communication_type text DEFAULT 'purchase_order';
-- Values: 'purchase_order', 'council', 'engineering'

-- email_events: add comms tracking fields
ALTER TABLE email_events ADD COLUMN IF NOT EXISTS comms_trigger text;
-- Values: 'quote_sent', 'quote_accepted', 'deposit_paid', 'materials_ordered',
-- 'council_submitted', 'council_approved', 'crew_scheduled', 'crew_arriving',
-- 'daily_progress', 'job_complete', 'invoice_sent', 'payment_received', 'follow_up_30d'

ALTER TABLE email_events ADD COLUMN IF NOT EXISTS comms_channel text DEFAULT 'email';
-- Values: 'email', 'sms', 'both'

CREATE INDEX IF NOT EXISTS idx_email_events_comms ON email_events(job_id, comms_trigger);

-- jobs: add callback and cross-sell fields
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS callback_parent_id uuid REFERENCES jobs(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_callback boolean DEFAULT false;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cross_sell_flags jsonb DEFAULT '[]';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cross_sell_source_job_id uuid REFERENCES jobs(id);


-- ────────────────────────────────────────────────────────────
-- 6. MIGRATE EXISTING VARIATIONS from job_events to job_variations
-- ────────────────────────────────────────────────────────────
INSERT INTO job_variations (job_id, description, amount, photo_url, status, needs_approval, created_by, approved_by, approved_at, approval_notes, created_at)
SELECT
  je.job_id,
  COALESCE(je.detail_json->>'description', 'Variation'),
  COALESCE((je.detail_json->>'estimated_cost')::numeric, 0),
  je.detail_json->>'photo_url',
  COALESCE(je.detail_json->>'status', 'pending_approval'),
  COALESCE((je.detail_json->>'needs_approval')::boolean, true),
  je.user_id,
  (je.detail_json->>'approved_by')::uuid,
  (je.detail_json->>'approved_at')::timestamptz,
  je.detail_json->>'approval_notes',
  je.created_at
FROM job_events je
WHERE je.event_type = 'variation_requested'
ON CONFLICT DO NOTHING;


-- ────────────────────────────────────────────────────────────
-- 7. COUNCIL STEP TEMPLATES — seed as a reference table
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS council_step_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_type text NOT NULL UNIQUE,
  template_name text NOT NULL,
  steps jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE council_step_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role manages templates" ON council_step_templates FOR ALL USING (auth.role() = 'service_role');

INSERT INTO council_step_templates (template_type, template_name, steps) VALUES
(
  'standard_council',
  'Standard Council (Patio/Fencing)',
  '[
    {"name": "Get Plans Drawn", "status": "pending"},
    {"name": "Get Engineering Certification", "status": "pending"},
    {"name": "Get CDC", "status": "pending"},
    {"name": "Submit Council Application", "status": "pending"},
    {"name": "Respond to Council Queries", "status": "pending"},
    {"name": "Building Permit Received", "status": "pending"}
  ]'::jsonb
),
(
  'development_approval',
  'Development Approval (Larger Projects)',
  '[
    {"name": "Development Approval Application", "status": "pending"},
    {"name": "Soil Testing", "status": "pending"},
    {"name": "Get Plans Drawn", "status": "pending"},
    {"name": "Get Engineering Certification", "status": "pending"},
    {"name": "Submit Building Permit Application", "status": "pending"},
    {"name": "Building Permit Received", "status": "pending"},
    {"name": "Notification of Completed Works", "status": "pending"}
  ]'::jsonb
),
(
  'retrospective',
  'Retrospective Approval',
  '[
    {"name": "Get Plans Drawn (As-Built)", "status": "pending"},
    {"name": "Get Engineering Certification", "status": "pending"},
    {"name": "Submit Retrospective Application", "status": "pending"},
    {"name": "Respond to Council Queries", "status": "pending"},
    {"name": "Approval Received", "status": "pending"}
  ]'::jsonb
)
ON CONFLICT (template_type) DO NOTHING;
