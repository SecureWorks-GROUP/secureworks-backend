-- Earlier cases provide the real job-work-order primitives and guards.
-- Extend only their reduced scope schema with the frozen byte contracts.
ALTER TABLE public.scope_revisions
  ADD COLUMN IF NOT EXISTS scope_canonical_text text,
  ADD COLUMN IF NOT EXISTS pricing_canonical_text text,
  ADD COLUMN IF NOT EXISTS scope_hash text,
  ADD COLUMN IF NOT EXISTS pricing_hash text;
ALTER TABLE public.work_orders ADD COLUMN IF NOT EXISTS scope_revision_id uuid;
