-- Narrow stand-ins only; the earlier review-intents case owns its real capture triggers.
\ir ../20261105003000_invoice_milestone_review_intents/setup.sql
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS xero_contact_id text,
  ADD COLUMN IF NOT EXISTS pricing_json jsonb;
ALTER TABLE public.quote_revisions ADD COLUMN IF NOT EXISTS pricing_snapshot_json jsonb;
CREATE TABLE IF NOT EXISTS public.job_contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid);

-- Supabase-style inherited grants must not defeat the migration's narrow grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
