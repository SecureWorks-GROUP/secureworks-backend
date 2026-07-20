-- ════════════════════════════════════════════════════════════
-- Learning & Graduation Infrastructure Migration
-- Run manually in Supabase SQL editor
-- Date: 2026-03-18
-- ════════════════════════════════════════════════════════════

-- 1. learned_rules table — AI-observed business patterns
CREATE TABLE IF NOT EXISTS learned_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  rule_type text NOT NULL,           -- e.g. 'supplier_preference', 'crew_assignment', 'scheduling_pattern'
  pattern_key text NOT NULL,         -- e.g. 'fencing+bunnings', 'patio+jbs'
  description text NOT NULL,         -- human-readable description of the pattern
  conditions jsonb DEFAULT '{}',     -- structured conditions for matching
  confidence numeric(4,3) NOT NULL DEFAULT 0.500,
  evidence_count int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'draft',  -- draft, confirmed, corrected, rejected
  confirmed_by text,                 -- who confirmed (telegram user name)
  confirmed_at timestamptz,
  correction_text text,              -- what the human corrected it to
  last_seen_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_learned_rules_status ON learned_rules(status);
CREATE INDEX IF NOT EXISTS idx_learned_rules_pattern_key ON learned_rules(pattern_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_learned_rules_org_pattern ON learned_rules(org_id, rule_type, pattern_key);

-- 2. ai_feedback_outcomes — add learned_example, confidence_at_decision, action_params columns
ALTER TABLE ai_feedback_outcomes
  ADD COLUMN IF NOT EXISTS learned_example jsonb,
  ADD COLUMN IF NOT EXISTS confidence_at_decision numeric(4,3),
  ADD COLUMN IF NOT EXISTS action_params jsonb;

-- 3. action_permissions — add graduated_at, graduated_by, downgrade_count columns
ALTER TABLE action_permissions
  ADD COLUMN IF NOT EXISTS graduated_at timestamptz,
  ADD COLUMN IF NOT EXISTS graduated_by text,
  ADD COLUMN IF NOT EXISTS downgrade_count int DEFAULT 0;

-- 4. Seed action_permissions rows for CONFIRM_ACTIONS types not already present
INSERT INTO action_permissions (org_id, action_type, autonomy_level)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'create_po', 'approve'),
  ('00000000-0000-0000-0000-000000000001', 'create_assignment', 'approve'),
  ('00000000-0000-0000-0000-000000000001', 'update_job_status', 'approve'),
  ('00000000-0000-0000-0000-000000000001', 'complete_and_invoice', 'approve'),
  ('00000000-0000-0000-0000-000000000001', 'assign_crew', 'approve')
ON CONFLICT (org_id, action_type) DO NOTHING;

-- 5. Seed new action_permissions for newly added tool capabilities
INSERT INTO action_permissions (org_id, action_type, autonomy_level)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'send_client_email', 'approve'),
  ('00000000-0000-0000-0000-000000000001', 'send_quote', 'approve'),
  ('00000000-0000-0000-0000-000000000001', 'push_po_to_xero', 'approve'),
  ('00000000-0000-0000-0000-000000000001', 'add_ghl_note', 'approve'),
  ('00000000-0000-0000-0000-000000000001', 'email_supplier_po', 'approve'),
  ('00000000-0000-0000-0000-000000000001', 'send_telegram', 'approve'),
  ('00000000-0000-0000-0000-000000000001', 'reconcile_payment', 'approve')
ON CONFLICT (org_id, action_type) DO NOTHING;

-- 6. RLS policy for scope decision logging from client-side tools
-- Allows the anon role to insert scope.decision events only
-- Enable RLS if not already (safe to re-run)
ALTER TABLE business_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow scope decision inserts from tools"
ON business_events FOR INSERT
TO anon
WITH CHECK (event_type = 'scope.decision');
