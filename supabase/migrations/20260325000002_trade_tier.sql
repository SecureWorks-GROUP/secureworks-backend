-- ════════════════════════════════════════════════════════════
-- Trade Tier — per-user tier for trade app feature gating
-- Tier 1 = crew (view only), 2 = lead installer, 3 = job manager
-- ════════════════════════════════════════════════════════════

ALTER TABLE users ADD COLUMN IF NOT EXISTS trade_tier integer DEFAULT 1;

COMMENT ON COLUMN users.trade_tier IS
  'Trade app tier: 1=crew (view only), 2=lead_installer (can message/call), 3=job_manager (full access + pricing)';

-- Set existing known users to their correct tiers
-- Tier 3: office + leads
UPDATE users SET trade_tier = 3 WHERE email ILIKE '%marnin%' OR email ILIKE '%henry%' OR email ILIKE '%shaun%' OR email ILIKE '%jan%' OR email ILIKE '%nithin%' OR email ILIKE '%khairo%';
-- Tier 2: lead installers
UPDATE users SET trade_tier = 2 WHERE email ILIKE '%isaac%' OR email ILIKE '%ryan%';
