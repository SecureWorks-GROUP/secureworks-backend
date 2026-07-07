-- profitability-job-costing M1 (profit-baseline-freeze) — U2 + U3
-- Write-once expected-cost baseline on jobs + canonical expected-fact read path.
--
-- Mission : coding/work/missions/profit-baseline-freeze-2026-07-03/CONTRACT.md
-- CP1     : ratified by Marnin 2026-07-05 — write-once jobs.expected_costs at
--           the acceptance transition, frozen-revision-sourced with a
--           live_fallback, write-once trigger, null = suppressed.
-- Wiki    : SecureWorks-GROUP/secureworks-wiki#110
--
-- ─────────────────────────────────────────────────────────────────────────────
-- HAND-APPLIED 2026-07-05 (M1 postflight gated batch; code shipped in PR #284
-- 2026-07-05 21:27 +0800, first live freeze recorded 2026-07-06 07:46 UTC) —
-- applied manually by the orchestrator after M1 CP2 + Marnin approval, NOT by CI
-- auto-migrate, and NOT recorded in supabase_migrations.schema_migrations (this
-- is why the repo was silent on it until M3-U1). Promoted out of _drafts/ and
-- RENUMBERED from the drafted 20260705000001 to 20260705000005 to resolve the
-- version collision with 20260705000001_users_managed_verticals.sql (Codex
-- blocker C1). Additive + idempotent (ADD COLUMN IF NOT EXISTS / CREATE OR
-- REPLACE / DROP TRIGGER IF EXISTS); a no-op on re-apply and on the live DB.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why
-- ─────────────────────────────────────────────────────────────────────────────
-- jobs.pricing_json is a live mirror that fence-designer/integration.js rebuilds
-- on every auto-save. Post-acceptance edits silently rewrite what a job was
-- supposed to cost (proven drift on an accepted fence job: cost $5,693 live vs
-- $4,902 frozen). Expected-vs-actual variance is untrustworthy until the
-- expected side is pinned. This migration pins it:
--
--   * jobs.expected_costs      jsonb  — the immutable baseline snapshot, written
--                                       once at the acceptance transition by
--                                       _shared/expected_costs/expected_costs_freeze.ts.
--   * jobs.expected_frozen_at  timestamptz — when that baseline was pinned.
--   * trg_jobs_expected_costs_write_once — makes both columns write-once at the
--                                       DB level (mirrors the controlled-
--                                       immutability posture of
--                                       trg_scope_revisions_controlled_immutable).
--   * v_job_expected_cost_facts — resolves the snapshot into canonical expected
--                                       money-fact rows (the expected-side input
--                                       to M3's v_job_money_facts).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Core principles
-- ─────────────────────────────────────────────────────────────────────────────
--   * Additive only. Two new nullable columns on jobs; one narrow BEFORE UPDATE
--     trigger; one view. No existing column, trigger, policy, or row changes.
--   * The write-once trigger is deliberately NARROW: a WHEN clause makes it a
--     no-op for the overwhelming majority of jobs UPDATEs (those where no
--     baseline exists yet). It fires only once a baseline is present, and then
--     only rejects a CHANGE to expected_costs / expected_frozen_at. Every other
--     column on jobs stays freely mutable — pricing_json auto-saves are
--     unaffected. This is what lets the live mirror keep drifting while the
--     baseline stays frozen.
--   * No backfill. This migration writes no rows. Historical accepted jobs get a
--     baseline only forward, at their next acceptance transition; backfilling
--     the ~320 historical accepted jobs is an explicit M3 decision behind a
--     separate Marnin gate (contract §Out of scope).
--   * NULL is suppressed, never fabricated. A job with no frozen revision and no
--     usable pricing_json gets NO row in expected_costs and NO fact rows in the
--     view.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback (time-to-revert: <1s; no data loss beyond the new columns' contents)
-- ─────────────────────────────────────────────────────────────────────────────
--   DROP VIEW    IF EXISTS public.v_job_expected_cost_facts;
--   DROP TRIGGER IF EXISTS trg_jobs_expected_costs_write_once ON public.jobs;
--   DROP FUNCTION IF EXISTS public.jobs_expected_costs_write_once();
--   ALTER TABLE public.jobs DROP COLUMN IF EXISTS expected_frozen_at;
--   ALTER TABLE public.jobs DROP COLUMN IF EXISTS expected_costs;

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Columns (U2)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS expected_costs     jsonb        NULL,
  ADD COLUMN IF NOT EXISTS expected_frozen_at timestamptz  NULL;

COMMENT ON COLUMN public.jobs.expected_costs IS
  'Write-once immutable expected-cost baseline, pinned at the acceptance transition by _shared/expected_costs/expected_costs_freeze.ts (M1 profitability-job-costing). Self-describing jsonb: {version, confidence in (frozen_revision|live_fallback), source_ref, scope_revision_id, pricing_hash, accepted_at, frozen_at, lanes:{labour|materials|commission:{amount_ex_gst}}, totals:{total_cost_ex_gst, margin_pct}}. NULL = no trustworthy baseline (no frozen revision and no usable pricing_json at accept-time); suppressed everywhere, never fabricated. Enforced write-once by trg_jobs_expected_costs_write_once. Do NOT confuse with jobs.pricing_json, which is a live mirror that drifts.';
COMMENT ON COLUMN public.jobs.expected_frozen_at IS
  'When jobs.expected_costs was pinned (== expected_costs->>frozen_at). Write-once alongside expected_costs.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Write-once trigger (U2) — mirrors the scope_revisions immutability posture
-- ─────────────────────────────────────────────────────────────────────────────
-- Rules:
--   expected_costs / expected_frozen_at: NULL -> NOT NULL once (the freeze).
--   Once NOT NULL, any CHANGE is refused (write-once). A no-op re-write of the
--   identical value is allowed (idempotent).
--   Setting back to NULL is refused (would erase a frozen baseline).
--   All other columns on jobs are untouched by this trigger.
CREATE OR REPLACE FUNCTION public.jobs_expected_costs_write_once()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.expected_costs IS NOT NULL
     AND NEW.expected_costs IS DISTINCT FROM OLD.expected_costs THEN
    RAISE EXCEPTION 'jobs.expected_costs is write-once (job %); a frozen expected-cost baseline cannot be modified or cleared', OLD.id
      USING errcode = '23514';
  END IF;
  IF OLD.expected_frozen_at IS NOT NULL
     AND NEW.expected_frozen_at IS DISTINCT FROM OLD.expected_frozen_at THEN
    RAISE EXCEPTION 'jobs.expected_frozen_at is write-once (job %)', OLD.id
      USING errcode = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_jobs_expected_costs_write_once ON public.jobs;
CREATE TRIGGER trg_jobs_expected_costs_write_once
  BEFORE UPDATE ON public.jobs
  FOR EACH ROW
  -- Only ever fires once a baseline exists on the row: no cost to the millions
  -- of ordinary jobs UPDATEs (pricing_json auto-saves, status moves, etc.).
  WHEN (OLD.expected_costs IS NOT NULL OR OLD.expected_frozen_at IS NOT NULL)
  EXECUTE FUNCTION public.jobs_expected_costs_write_once();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Canonical read path (U3) — v_job_expected_cost_facts
-- ─────────────────────────────────────────────────────────────────────────────
-- Resolves the snapshot into the fixed expected money-fact contract, one row
-- per present lane. This is the expected-side input to M3's v_job_money_facts.
--
-- Field contract (do NOT change without a contract amendment):
--   job_id             uuid        — the job
--   lane               text        — 'labour' | 'materials' | 'commission'
--   expected           boolean     — always true (marks the row as an
--                                     expected-side fact vs an actual-side fact)
--   amount_ex_gst      numeric     — the frozen ex-GST cost for the lane
--   source_ref         text        — frozen scope_revision_id (frozen_revision)
--                                     or the jobs.id carrying the snapshot
--                                     (live_fallback)
--   confidence         text        — 'frozen_revision' | 'live_fallback'
--   expected_frozen_at timestamptz — when the baseline was pinned
--
-- Suppression: a job with expected_costs IS NULL yields NO rows; a lane whose
-- amount is absent yields NO row for that lane. Absent row == suppressed.
--
-- security_invoker = true so the view respects the caller's RLS on jobs rather
-- than silently bypassing it (reads route through service-role ops-api /
-- reporting-api, same as the rest of the reporting surface).
CREATE OR REPLACE VIEW public.v_job_expected_cost_facts
WITH (security_invoker = true) AS
SELECT
  j.id                                                                       AS job_id,
  lane.lane                                                                  AS lane,
  true                                                                       AS expected,
  (j.expected_costs #>> ARRAY['lanes', lane.lane, 'amount_ex_gst'])::numeric AS amount_ex_gst,
  (j.expected_costs ->> 'source_ref')                                        AS source_ref,
  (j.expected_costs ->> 'confidence')                                        AS confidence,
  j.expected_frozen_at                                                       AS expected_frozen_at
FROM public.jobs j
CROSS JOIN LATERAL (VALUES ('labour'), ('materials'), ('commission')) AS lane(lane)
WHERE j.expected_costs IS NOT NULL
  AND (j.expected_costs #>> ARRAY['lanes', lane.lane, 'amount_ex_gst']) IS NOT NULL;

COMMENT ON VIEW public.v_job_expected_cost_facts IS
  'M1 profitability-job-costing U3: canonical expected money-fact rows resolved from jobs.expected_costs. One row per present lane (labour|materials|commission); job_id, lane, expected(=true), amount_ex_gst, source_ref, confidence(frozen_revision|live_fallback), expected_frozen_at. Absent row = suppressed (no baseline, or lane missing). Expected-side input to M3 v_job_money_facts.';

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Historical apply record (this file is the promoted, now-applied migration)
-- ─────────────────────────────────────────────────────────────────────────────
-- Postflight verification at apply time (read-only), re-confirmed live at M3-U1
-- on 2026-07-07:
--   - information_schema.columns: jobs.expected_costs + expected_frozen_at present (2 rows).
--   - to_regclass('public.v_job_expected_cost_facts') resolves (7-col contract intact).
--   - pg_trigger: trg_jobs_expected_costs_write_once present (1 row).
-- Negative test proven at M1 canary (service-role, disposable job): first write
-- succeeds; a subsequent CHANGE to expected_costs raises 23514; clearing to NULL
-- raises 23514; pricing_json auto-saves on the same job still succeed.
