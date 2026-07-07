-- MakeSafe Portal-Truth status sync (M-E1 / W2-C, 2026-07-08)
--
-- Backend-request items 7 + 14 (2026-07-06 intake-engine-hardening.md).
--
-- FEASIBILITY (proven 2026-07-07, evidence-based): the primeeco portal share
-- pages (https://primeeco.tech/share/<token>) are a client-rendered Angular SPA.
-- A plain server-side GET returns only a ~9 KB JS shell — the "form has been
-- locked" banner and the "N of M answered" counter that decide submitted-vs-not
-- exist ONLY after client JS runs. The data comes from a PRIVATE, unversioned
-- same-origin API that first exchanges the share token for an access token
-- (POST /api/authentication/share-reference-token -> {accessToken, customFormId},
-- which carries NO lock state) and would then need a second authed form fetch
-- against an undocumented "locked" field. Replaying a builder's private share
-- login from our backend to gate invoices is brittle third-party-auth-replay
-- that silently breaks the money gate the day Prime changes it — the exact
-- "graf" failure class we are killing. So server-side auto-detection is NOT
-- built. The deterministic, side-effect-free detector already exists and is the
-- right tool: the reporting skill's capture_portal_evidence.py (headless Chrome +
-- the exact lock-banner classifier, fail-closed on ambiguity), run agent-side.
--
-- This migration therefore backs the HONEST FALLBACK + the item-14 guard:
--   (1) portal_verified_* — a RECORDED portal-locked verification, cycle-scoped.
--       Written ONLY by mark_makesafe_portal_report_done (a human/agent that saw
--       the locked portal, or an agent run that captured locked=true). The
--       item-14 guard requires this before any AUTOMATED substatus advance or
--       draft-invoice on a report-type card. cycle-scoping means a reopen/
--       re-attend (cycle_number bump) invalidates a stale verification.
--   (2) portal_recheck_* — the durable recheck QUEUE marker that agent-side runs
--       (capture_portal_evidence.py) consume: the enqueue cron stamps eligible
--       report-type cards so a scheduled agent knows exactly which portals to
--       re-check, with a rate-limit timestamp + a visit counter.
--
-- Safety: additive only. No existing rows altered, no data destroyed, no sends,
-- no invoice changes. Apply via the standard migration-approval gate before prod.

-- 1) Recorded portal-locked verification (item-14 gate input).
ALTER TABLE public.makesafe_job_details
  ADD COLUMN IF NOT EXISTS portal_verified_at    timestamptz,
  ADD COLUMN IF NOT EXISTS portal_verified_cycle integer,
  ADD COLUMN IF NOT EXISTS portal_verified_signal text,
  ADD COLUMN IF NOT EXISTS portal_verified_by    text;

COMMENT ON COLUMN public.makesafe_job_details.portal_verified_at IS
  'When a portal-locked verification was recorded for this report-type card (mark_makesafe_portal_report_done). NULL = never verified. The item-14 guard blocks any automated substatus advance / draft invoice on a report-type card unless this is set for the CURRENT cycle (see portal_verified_cycle).';
COMMENT ON COLUMN public.makesafe_job_details.portal_verified_cycle IS
  'cycle_number at the moment portal verification was recorded. A reopen/re-attend increments cycle_number, so a stale prior-cycle verification no longer satisfies the guard — the new cycle must be re-verified before it can advance/invoice.';
COMMENT ON COLUMN public.makesafe_job_details.portal_verified_signal IS
  'Human-readable lock signal captured at verification time (e.g. "form locked/submitted, 30 of 33 answered" from capture_portal_evidence.py, or "operator-confirmed portal locked"). Audit only.';
COMMENT ON COLUMN public.makesafe_job_details.portal_verified_by IS
  'Actor that recorded the verification (operator email, agent run id, or "portal_done_marker"). Audit only.';

-- 2) Recheck queue marker (honest fallback that agent runs consume).
ALTER TABLE public.makesafe_job_details
  ADD COLUMN IF NOT EXISTS portal_recheck_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS portal_recheck_count        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS portal_recheck_reason       text;

COMMENT ON COLUMN public.makesafe_job_details.portal_recheck_requested_at IS
  'Most recent time the portal-recheck enqueue cron flagged this card for an agent-side portal re-check (capture_portal_evidence.py). NULL = never enqueued. Rate-limit anchor: the enqueue is idempotent within its cadence window against this value.';
COMMENT ON COLUMN public.makesafe_job_details.portal_recheck_count IS
  'Number of times this card has been enqueued for a portal re-check. Rising with no verification = a stuck report portal an agent/human should chase.';
COMMENT ON COLUMN public.makesafe_job_details.portal_recheck_reason IS
  'Why the card was last enqueued (e.g. "report-type card with portal link, not verified this cycle").';

-- Queue read helper index: report-type cards awaiting verification.
CREATE INDEX IF NOT EXISTS idx_makesafe_details_portal_recheck
  ON public.makesafe_job_details (portal_verified_at, portal_recheck_requested_at)
  WHERE report_type IS NOT NULL;
