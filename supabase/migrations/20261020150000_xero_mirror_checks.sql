-- The invoice mirror check (Shaun approved 20 Oct 2026).
--
-- Our Xero copy (xero_invoices) said we were owed $104,681.66 across 82 invoices while
-- Xero said $108,034.14 across 87. The five missing invoices were open in Xero but sat in
-- our copy as DELETED with nothing owing: until 10 Sep 2026 (#797) the hourly stale check
-- in xero-sync marked an invoice DELETED whenever its read from Xero failed, for any
-- reason. Nothing ever re-read them.
--
-- xero-sync now compares our copy with Xero's own open list at most once an hour, heals
-- the copy from Xero by invoice id where Xero says money is owed, and records the result
-- here (supabase/functions/xero-sync/xero_mirror_check.ts). The Debt tab and the debt
-- report read the newest row to say "Matches Xero" or which invoices differ.
--
-- This migration only creates the table. It writes no invoice row and calls nothing; the
-- first check runs inside the next xero-sync sync_invoices after the matching deploy.
-- Re-applying is a no-op.

CREATE TABLE IF NOT EXISTS public.xero_mirror_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  checked_at timestamptz NOT NULL DEFAULT now(),
  -- False when the check could not finish (Xero busy, a list it could not verify); then
  -- the figures below are null and error says why.
  complete boolean NOT NULL,
  -- True when both sides hold the same open invoices with the same amounts.
  matches boolean,
  xero_count integer CHECK (xero_count IS NULL OR xero_count >= 0),
  xero_total numeric(14, 2),
  copy_count integer CHECK (copy_count IS NULL OR copy_count >= 0),
  copy_total numeric(14, 2),
  -- The invoices that still differ after healing, and what was healed this run.
  differ_count integer NOT NULL DEFAULT 0 CHECK (differ_count >= 0),
  differences jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(differences) = 'array'),
  healed jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(healed) = 'array'),
  heal_failed jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(heal_failed) = 'array'),
  -- Xero's DRAFT sales invoices (never part of what is owed), for the Debt tab's
  -- "drafts not sent" line. Null when they could not be read.
  drafts_count integer CHECK (drafts_count IS NULL OR drafts_count >= 0),
  drafts_total numeric(14, 2),
  error text,
  -- A complete check always carries both sides' figures.
  CONSTRAINT xero_mirror_checks_complete_has_figures CHECK (
    NOT complete OR (
      matches IS NOT NULL AND xero_count IS NOT NULL AND xero_total IS NOT NULL
      AND copy_count IS NOT NULL AND copy_total IS NOT NULL
    )
  )
);
CREATE INDEX IF NOT EXISTS idx_xero_mirror_checks_recent
  ON public.xero_mirror_checks (org_id, checked_at DESC);
COMMENT ON TABLE public.xero_mirror_checks IS
  'One row per invoice mirror check: our Xero copy (xero_invoices) against Xero''s own open sales invoice list, with both totals and the invoices that differ. Written by xero-sync (xero_mirror_check.ts), read by ops-api debt_ws_overview and the debt report. Rows older than 60 days are removed by xero-sync.';

ALTER TABLE public.xero_mirror_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS xero_mirror_checks_service_role_all ON public.xero_mirror_checks;
CREATE POLICY xero_mirror_checks_service_role_all ON public.xero_mirror_checks
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.xero_mirror_checks FROM anon, authenticated;
