-- ════════════════════════════════════════════════════════════
-- MAKE-SAFE EMAIL SYNC — reconciliation (D1-D4) schema additions (Phase 2)
-- Mission: makesafe-live-truth-2026-06-14
-- ════════════════════════════════════════════════════════════
--
-- Additive to the Phase-1 schema (20260614000001). Adds:
--   1. sync_state.recon_* columns — the queryable "verified" gate signal that
--      the board + skills read (DEGRADED while unresolved D1/D2 drift exists).
--   2. makesafe_canary_expectations — one row per outstanding D4 canary; the
--      synthetic email is seeded out-of-band (gated/manual), this table records
--      the expectation the scheduled D4 check verifies against within SLA.
--
-- INERT: no cron, no data. The reconcile/canary cron lives in the companion
-- cron migration and is enabled LAST (Stage C), after consent + owner approval.
--
-- All additions are service-role-only, matching the Phase-1 RLS posture.

-- ── 1. sync_state: verified-gate signal columns ──────────────────────────────
-- summarizeDrift() persists its result here so reads don't have to re-run a full
-- reconcile. recon_verified = false BLOCKS the verified gate (board shows DEGRADED).
--
-- B2/B3 FIX: D1 and D2 run on SEPARATE cron schedules. The combined recon_verified
-- must require BOTH d1 clean AND d2 clean — so each check persists its OWN signal
-- and reads the OTHER's last persisted signal before combining. D1 must NEVER
-- overwrite/clear an unresolved D2 drift (and vice-versa). The per-check columns
-- below make that possible:
--   recon_d1_*            — last D1 reconcile result (drift + verified)
--   recon_d2_*            — last D2 full-inventory result (missing posts + verified)
--   recon_inventory_floor — B3 coverage LOWER bound: the earliest datetime that has
--                           been FULLY inventoried by D2 (or the historical backfill).
--                           recon_verified may only claim coverage at/after this
--                           bound; older posts are NOT claimed verified.
--   recon_inventory_ceiling — the latest datetime D2's recurring sweep covered.
ALTER TABLE public.sync_state
  ADD COLUMN IF NOT EXISTS recon_verified  boolean,
  ADD COLUMN IF NOT EXISTS recon_mode      text
    CHECK (recon_mode IS NULL OR recon_mode IN ('OK', 'DEGRADED', 'ERROR')),
  ADD COLUMN IF NOT EXISTS recon_reason    text,
  ADD COLUMN IF NOT EXISTS recon_checked_at timestamptz,
  -- B2: per-check persisted signals so neither check clobbers the other.
  ADD COLUMN IF NOT EXISTS recon_d1_verified   boolean,
  ADD COLUMN IF NOT EXISTS recon_d1_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS recon_d1_email_no_job integer,
  ADD COLUMN IF NOT EXISTS recon_d2_verified   boolean,
  ADD COLUMN IF NOT EXISTS recon_d2_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS recon_d2_missing_posts integer,
  -- B3: explicit coverage bounds. recon_verified is only meaningful WITHIN these.
  ADD COLUMN IF NOT EXISTS recon_inventory_floor   timestamptz,
  ADD COLUMN IF NOT EXISTS recon_inventory_ceiling timestamptz;

-- ── 2. makesafe_canary_expectations — outstanding D4 canaries ─────────────────
-- The synthetic make-safe email is sent to ses@ out-of-band (NEVER from the
-- engine — no live send in this mission). seedCanaryExpectation() records the
-- unique marker + SLA here; the scheduled D4 check (makesafeEmailCanary) verifies
-- the marker landed in the store WITH a PDF attachment AND a threaded reply
-- within sla_minutes, else raises a canary_missing alert.
CREATE TABLE IF NOT EXISTS public.makesafe_canary_expectations (
  marker                 text PRIMARY KEY,        -- unique subject/body marker
  seeded_at              timestamptz NOT NULL DEFAULT now(),
  sla_minutes            integer NOT NULL DEFAULT 30,
  require_pdf            boolean NOT NULL DEFAULT true,
  require_threaded_reply boolean NOT NULL DEFAULT true,
  resolved               boolean NOT NULL DEFAULT false,
  resolved_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_canary_expectations_unresolved
  ON public.makesafe_canary_expectations(resolved);

-- ── RLS — service-role only (deny-all to anon/authenticated) ──────────────────
ALTER TABLE public.makesafe_canary_expectations ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.makesafe_canary_expectations TO service_role;
DROP POLICY IF EXISTS service_role_all ON public.makesafe_canary_expectations;
CREATE POLICY service_role_all ON public.makesafe_canary_expectations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.makesafe_canary_expectations IS
  'Make-safe email sync D4 canary: one row per outstanding synthetic canary. The
   email is seeded out-of-band (gated/manual; no live send in-engine). The
   scheduled D4 check verifies presence + PDF attachment + threaded reply
   within sla_minutes.';

-- email_events_raw.change_type already free-text (no enum); the D2 inventory scan
-- uses change_type = 'inventory_scan' with the post-id sentinel
-- '_D2_INVENTORY_SCAN'. No schema change required for that.
--
-- NOTE (M4): the cron enablement gate (makesafe_cron_settings + the
-- makesafe_cron_enabled() helper the trigger functions check) is defined in the
-- BASE schema migration 20260614000001, because the Phase-1 cron migration
-- (20260614000002) — which applies BEFORE this one — already references it. See
-- that migration's "M4: cron enablement gate" section.
