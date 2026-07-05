-- profitability-job-costing M1 (profit-baseline-freeze) — U2 + U3
-- Write-once expected-cost baseline on jobs + canonical expected-fact read path.
--
-- Status: DRAFT — NOT APPLIED. Lives in supabase/migrations/_drafts/ so
--   `supabase db push` does NOT pick it up. Applying is Marnin-gated at CP2
--   (money path: Codex ground-truth AND Marnin sign-off). Do not promote to
--   supabase/migrations/ or run apply_migration / db push before that gate.
--
-- Mission : coding/work/missions/profit-baseline-freeze-2026-07-03/CONTRACT.md
-- CP1     : ratified by Marnin 2026-07-05 — write-once jobs.expected_costs at
--           the acceptance transition, frozen-revision-sourced with a
--           live_fallback, write-once trigger, null = suppressed.
-- Wiki    : SecureWorks-GROUP/secureworks-wiki#110
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
-- Apply notes (for the operator at CP2 — NOT executed by this file)
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Promote out of _drafts/ to supabase/migrations/ and rename the prefix to
--    match the Supabase ledger version at apply time (the scope_revisions
--    migration header documents this promote-then-rename convention).
-- 2. Preflight (read-only):
--      - confirm jobs.expected_costs / expected_frozen_at do NOT already exist:
--          SELECT column_name FROM information_schema.columns
--            WHERE table_schema='public' AND table_name='jobs'
--              AND column_name IN ('expected_costs','expected_frozen_at');   -- expect 0 rows
-- 3. Apply via the approved Supabase path (Studio SQL editor paste, OR
--    `supabase db push` after promotion, OR apply_migration). Fully
--    transactional.
-- 4. Postflight verification (read-only):
--      - SELECT count(*) FROM information_schema.columns
--          WHERE table_schema='public' AND table_name='jobs'
--            AND column_name IN ('expected_costs','expected_frozen_at');      -- expect 2
--      - SELECT to_regclass('public.v_job_expected_cost_facts');              -- expect the view
--      - SELECT tgname FROM pg_trigger WHERE tgname='trg_jobs_expected_costs_write_once'; -- expect 1
-- 5. Negative test at canary (service-role client, disposable job):
--      a. UPDATE a job's pricing_json / status with expected_costs still NULL
--         -> expect success (trigger WHEN clause skips it).
--      b. UPDATE jobs SET expected_costs = '{"version":1,...}'::jsonb WHERE id=... (first write)
--         -> expect success.
--      c. UPDATE jobs SET expected_costs = '{"version":1,"tampered":true}'::jsonb WHERE id=...
--         -> expect 23514 raise (write-once).
--      d. UPDATE jobs SET expected_costs = NULL WHERE id=...
--         -> expect 23514 raise (cannot clear).
--      e. UPDATE the same job's pricing_json again (baseline already set)
--         -> expect success (only expected_costs/expected_frozen_at are locked).
