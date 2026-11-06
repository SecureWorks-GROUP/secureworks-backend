\ir ../20261105130000_invoice_milestone_draft_claims/setup.sql
ALTER TABLE public.council_submissions ADD COLUMN IF NOT EXISTS org_id uuid;
