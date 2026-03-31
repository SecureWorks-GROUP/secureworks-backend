-- ============================================================
-- Step 1: Fix feedback loop + bootstrap learned rules
-- ============================================================
-- CRITICAL BUG: ai_feedback_outcomes.trace_id has NOT NULL constraint
-- but ops-ai inserts trace_id: null. Every feedback insert silently fails.
-- The entire learning loop is dead until this is fixed.

-- 1. Fix the NOT NULL constraint killing all feedback inserts
ALTER TABLE ai_feedback_outcomes ALTER COLUMN trace_id DROP NOT NULL;

-- 2. Seed learned_rules with known business patterns
-- These are confirmed real-world rules that ops-ai will use immediately
INSERT INTO learned_rules (org_id, rule_type, pattern_key, description, conditions, confidence, evidence_count, status, confirmed_by, confirmed_at) VALUES
('00000000-0000-0000-0000-000000000001', 'assign', 'assign:patio+isaac_ryan', 'Isaac and Ryan are the primary patio installation crew', '{}', 0.85, 50, 'confirmed', 'marnin', now()),
('00000000-0000-0000-0000-000000000001', 'assign', 'assign:fencing+henry', 'Henry manages all fencing division jobs', '{}', 0.90, 50, 'confirmed', 'marnin', now()),
('00000000-0000-0000-0000-000000000001', 'po', 'po:bondor+solarspan', 'SolarSpan insulated panels come from Bondor only', '{}', 0.99, 100, 'confirmed', 'marnin', now()),
('00000000-0000-0000-0000-000000000001', 'po', 'po:metroll+roofing', 'Metroll supplies Trimdek, SpanPlus, CDek, steel flashings', '{}', 0.90, 50, 'confirmed', 'marnin', now()),
('00000000-0000-0000-0000-000000000001', 'po', 'po:cmi+steel', 'CMI is the primary steel fabrication supplier — Malaga pickup', '{}', 0.90, 40, 'confirmed', 'marnin', now()),
('00000000-0000-0000-0000-000000000001', 'status', 'status:deposit_before_materials', 'Materials must not be ordered until deposit is confirmed paid', '{}', 0.99, 100, 'confirmed', 'marnin', now()),
('00000000-0000-0000-0000-000000000001', 'status', 'status:schedule_within_5d', 'Jobs should be scheduled within 5 business days of acceptance', '{}', 0.85, 40, 'confirmed', 'marnin', now()),
('00000000-0000-0000-0000-000000000001', 'status', 'status:patio_2_3_days', 'Standard patio installs take 2-3 days for jobs under 40sqm', '{}', 0.85, 30, 'confirmed', 'marnin', now()),
('00000000-0000-0000-0000-000000000001', 'status', 'status:fencing_1_2_days', 'Fencing jobs complete in 1-2 days for runs under 30m', '{}', 0.85, 30, 'confirmed', 'marnin', now()),
('00000000-0000-0000-0000-000000000001', 'status', 'status:concrete_cure_48h', 'Concrete footings need 24-48 hours to cure before steel installation', '{}', 0.95, 50, 'confirmed', 'marnin', now())
ON CONFLICT (org_id, rule_type, pattern_key) DO NOTHING;
