-- ════════════════════════════════════════════════════════════
-- AI Health Check Fixes — 2026-03-20
-- Fixes: learned_rules visibility, annotation RLS policies,
-- PostgREST schema cache refresh
-- ════════════════════════════════════════════════════════════

-- 1. Ensure learned_rules exists (idempotent)
CREATE TABLE IF NOT EXISTS learned_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  rule_type text NOT NULL,
  pattern_key text NOT NULL,
  description text NOT NULL,
  conditions jsonb DEFAULT '{}',
  confidence numeric(4,3) NOT NULL DEFAULT 0.500,
  evidence_count int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'draft',
  confirmed_by text,
  confirmed_at timestamptz,
  correction_text text,
  last_seen_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_learned_rules_status ON learned_rules(status);
CREATE INDEX IF NOT EXISTS idx_learned_rules_pattern_key ON learned_rules(pattern_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_learned_rules_org_pattern ON learned_rules(org_id, rule_type, pattern_key);

-- 2. Enable RLS on learned_rules (safe to re-run)
ALTER TABLE learned_rules ENABLE ROW LEVEL SECURITY;

-- 3. GRANT access to PostgREST roles so schema cache discovers the tables
GRANT SELECT, INSERT, UPDATE ON learned_rules TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON ai_annotations TO anon, authenticated;
GRANT SELECT ON learned_rules TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON learned_rules TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_annotations TO service_role;

-- 4. RLS policies for learned_rules — service role bypasses, anon can read confirmed rules
CREATE POLICY "Service role full access on learned_rules"
  ON learned_rules FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Anon read confirmed rules"
  ON learned_rules FOR SELECT
  TO anon, authenticated
  USING (status IN ('confirmed', 'corrected'));

-- 5. RLS policies for ai_annotations — service role full access, anon read active
CREATE POLICY "Service role full access on ai_annotations"
  ON ai_annotations FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Anon read active annotations"
  ON ai_annotations FOR SELECT
  TO anon, authenticated
  USING (status = 'active');

-- 6. Ensure ai_feedback_outcomes has proper access
GRANT SELECT, INSERT, UPDATE ON ai_feedback_outcomes TO service_role;
GRANT SELECT ON ai_feedback_outcomes TO anon, authenticated;

-- 7. Ensure ai_alerts has proper access
GRANT SELECT, INSERT ON ai_alerts TO service_role;
GRANT SELECT ON ai_alerts TO anon, authenticated;

-- 8. Ensure business_events service role access
GRANT SELECT, INSERT ON business_events TO service_role;

-- 9. Ensure action_permissions has org_id for graduation queries
-- The action_permissions table uses (org_id, action_type) as composite key
-- but earlier seeds may not have org_id. Add it if missing.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'action_permissions' AND column_name = 'org_id'
  ) THEN
    ALTER TABLE action_permissions ADD COLUMN org_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
  END IF;
END $$;

-- 10. Force PostgREST schema cache reload
NOTIFY pgrst, 'reload schema';
