-- Add GHL opportunity ID to jobs table
-- Links Supabase jobs to GoHighLevel opportunities (separate from ghl_contact_id)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ghl_opportunity_id text;

-- Index for lookups by opportunity ID
CREATE INDEX IF NOT EXISTS idx_jobs_ghl_opportunity ON jobs (ghl_opportunity_id) WHERE ghl_opportunity_id IS NOT NULL;
