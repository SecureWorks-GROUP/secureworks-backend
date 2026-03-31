-- ════════════════════════════════════════════════════════════
-- AI Annotations — Phase 1 Migration
-- Inline AI intelligence embedded in work surfaces
-- ════════════════════════════════════════════════════════════

-- Fix ai_alerts severity constraint (allows 'info' for graduation candidates etc.)
ALTER TABLE ai_alerts DROP CONSTRAINT IF EXISTS ai_alerts_severity_check;
ALTER TABLE ai_alerts ADD CONSTRAINT ai_alerts_severity_check CHECK (severity IN ('red', 'amber', 'info'));

-- ai_annotations table
CREATE TABLE IF NOT EXISTS ai_annotations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  entity_type     text NOT NULL,          -- 'job', 'purchase_order', 'invoice', 'assignment', 'global'
  entity_id       uuid,
  ui_location     text NOT NULL,          -- 'job_overview', 'job_money', 'job_build', 'today', 'backlog'
  annotation_type text NOT NULL,          -- 'unlinked_invoice', 'materials_not_confirmed', 'pattern_confirm', etc.
  category        text NOT NULL,          -- 'financial', 'operational', 'learning', 'pricing', 'sales', 'client'
  title           text NOT NULL,
  body            text,
  structured_data jsonb DEFAULT '{}',
  response_type   text NOT NULL DEFAULT 'dismiss',  -- 'dismiss', 'confirm_dismiss', 'choice', 'input'
  response_options jsonb DEFAULT '[]',
  priority        int NOT NULL DEFAULT 50,
  severity        text NOT NULL DEFAULT 'info',
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  escalates_at    timestamptz,
  status          text NOT NULL DEFAULT 'active',
  resolved_at     timestamptz,
  resolved_by     text,
  resolution      jsonb,
  snooze_until    timestamptz,
  source          text NOT NULL,
  source_ref      text,
  persona_voice   text,
  confidence      numeric(4,3)
);

-- Index: fast lookup by entity for active annotations
CREATE INDEX IF NOT EXISTS idx_annotations_entity ON ai_annotations(entity_type, entity_id) WHERE status = 'active';

-- Index: global active annotations query
CREATE INDEX IF NOT EXISTS idx_annotations_active ON ai_annotations(org_id, status) WHERE status = 'active';

-- Index: dedup — one active annotation per source_ref
CREATE UNIQUE INDEX IF NOT EXISTS idx_annotations_dedup ON ai_annotations(source_ref) WHERE source_ref IS NOT NULL AND status = 'active';
