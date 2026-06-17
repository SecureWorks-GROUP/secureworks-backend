-- ══════════════════════════════════════════════════════════════
-- Migration: jobs lean stored columns + self-maintaining trigger
-- Timestamp: 20260617000003
-- Branch: perf/lean-columns-2026-06-17
-- Contract: coding/work/missions/scope-ops-speed-2026-06-17/CONTRACT.md
--
-- APPLY ORDER (gated — General + Marnin gate each step):
--   1. Apply this migration (adds columns + trigger)
--   2. Run the one-shot backfill SQL below (separate SQL editor run — fills existing rows)
--   3. Run all four gate verification queries — all must return 0 mismatches / expected ratios
--   4. Only THEN apply the read-path switch (pipeline/opsSummary/updateJobStatus/
--      opportunities/search_jobs). Those changes are NOT in this migration.
--
-- DO NOT apply the backfill or read-path switch in the same step as this migration.
-- ══════════════════════════════════════════════════════════════


-- ── 1. Add lean stored columns to jobs ────────────────────────────────────────
--
-- quoted_amount: canonical INC-GST total from pricing_json->>'totalIncGST'.
--   NULL = job has no pricing yet (draft or unscoped). Set by trigger.
--
-- has_scope: true when scope_json is non-null and non-empty object.
--   Set by trigger on every write that touches scope_json.
--
-- neighbour_count: count of fencing neighbours from pricing_json neighbour arrays.
--   Always 0 for non-fencing jobs. Set by trigger on every write that touches pricing_json.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS quoted_amount   numeric(12,2);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS has_scope       boolean NOT NULL DEFAULT false;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS neighbour_count smallint NOT NULL DEFAULT 0;


-- ── 2. Trigger function ────────────────────────────────────────────────────────
--
-- Fires BEFORE INSERT OR UPDATE on jobs.
-- On INSERT: always computes the three columns from NEW.scope_json / NEW.pricing_json.
-- On UPDATE: only recomputes when scope_json or pricing_json actually changed, so
--   status-only drags (kanban moves) that touch neither fat column pay zero extra cost.
--
-- This makes the columns drift-proof: every write path — save_scope, the ops-api
-- syncFencingNeighbours fast-path (ops-api:24352), the ghl-proxy opportunity sync
-- (ghl-proxy:2532), the AI agent, or any future migration — is automatically covered.
-- No app-level population is needed or present in the edge functions.
--
-- Logic mirrors the backfill SQL exactly (single source of truth):
--   quoted_amount  = (pricing_json->>'totalIncGST')::numeric
--   has_scope      = scope_json IS NOT NULL AND scope_json != '{}'
--   neighbour_count = fencing ? coalesce(array_length(neighbour_splits.neighbours),
--                                        array_length(job.neighbours), 0) : 0

CREATE OR REPLACE FUNCTION jobs_lean_columns_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- On UPDATE, skip recompute if neither fat column changed (avoids de-TOASTing on
  -- status-only writes — the common case from kanban drags).
  IF TG_OP = 'UPDATE'
     AND (NEW.pricing_json IS NOT DISTINCT FROM OLD.pricing_json)
     AND (NEW.scope_json   IS NOT DISTINCT FROM OLD.scope_json)
  THEN
    RETURN NEW;
  END IF;

  -- has_scope: non-null, non-empty scope_json
  NEW.has_scope := (NEW.scope_json IS NOT NULL AND NEW.scope_json != '{}'::jsonb);

  -- quoted_amount: totalIncGST is the canonical INC-GST field written by both
  -- patio-tool (buildPricingJson:29534) and fence-designer (buildPricingJson:12741).
  -- Absent on unpriced / draft jobs -> NULL.
  NEW.quoted_amount := (NEW.pricing_json->>'totalIncGST')::numeric;

  -- neighbour_count: fencing jobs only; 0 for all other types.
  IF NEW.type = 'fencing' THEN
    NEW.neighbour_count := COALESCE(
      jsonb_array_length(NEW.pricing_json->'neighbour_splits'->'neighbours'),
      jsonb_array_length(NEW.pricing_json->'job'->'neighbours'),
      0
    );
  ELSE
    NEW.neighbour_count := 0;
  END IF;

  RETURN NEW;
END;
$$;

-- Create trigger (DROP first so the migration is idempotent on re-run)
DROP TRIGGER IF EXISTS jobs_lean_columns_trigger ON jobs;

CREATE TRIGGER jobs_lean_columns_trigger
  BEFORE INSERT OR UPDATE ON jobs
  FOR EACH ROW
  EXECUTE FUNCTION jobs_lean_columns_fn();


-- ══════════════════════════════════════════════════════════════
-- ONE-SHOT BACKFILL — run SEPARATELY in Supabase SQL editor after migration is applied.
-- Fills existing rows that predate the trigger. Not included in the migration body
-- because it touches all 1,920+ rows and is better run interactively with timing.
-- Expected runtime: < 5 seconds.
--
-- Copy from UPDATE to the closing semicolon and paste into the SQL editor:
-- ══════════════════════════════════════════════════════════════
/*
UPDATE jobs
SET
  quoted_amount   = (pricing_json->>'totalIncGST')::numeric,
  has_scope       = (scope_json IS NOT NULL AND scope_json != '{}'::jsonb),
  neighbour_count = CASE
    WHEN type = 'fencing' THEN
      COALESCE(
        jsonb_array_length(pricing_json->'neighbour_splits'->'neighbours'),
        jsonb_array_length(pricing_json->'job'->'neighbours'),
        0
      )
    ELSE 0
  END
WHERE org_id = '00000000-0000-0000-0000-000000000001'
  AND legacy IS NOT TRUE;
*/


-- ══════════════════════════════════════════════════════════════
-- GATE VERIFICATION QUERIES — run after backfill, all must pass before read-path switch.
-- ══════════════════════════════════════════════════════════════

-- Gate 1: quoted_amount matches pricing_json->>'totalIncGST' within 1 cent
/*
SELECT
  COUNT(*) AS total_jobs,
  COUNT(*) FILTER (
    WHERE ABS(
      COALESCE(quoted_amount, 0) -
      COALESCE((pricing_json->>'totalIncGST')::numeric, 0)
    ) > 0.01
  ) AS mismatch_count
FROM jobs
WHERE org_id = '00000000-0000-0000-0000-000000000001'
  AND legacy IS NOT TRUE
  AND quoted_amount IS NOT NULL;
-- GATE: mismatch_count = 0
*/

-- Gate 2: neighbour_count matches the neighbour array length in pricing_json
/*
SELECT
  COUNT(*) AS fencing_jobs,
  COUNT(*) FILTER (
    WHERE neighbour_count != COALESCE(
      jsonb_array_length(pricing_json->'neighbour_splits'->'neighbours'),
      jsonb_array_length(pricing_json->'job'->'neighbours'),
      0
    )
  ) AS neighbour_mismatch
FROM jobs
WHERE type = 'fencing'
  AND org_id = '00000000-0000-0000-0000-000000000001'
  AND legacy IS NOT TRUE;
-- GATE: neighbour_mismatch = 0
*/

-- Gate 3: has_scope matches the JSON presence check
/*
SELECT
  COUNT(*) AS total_jobs,
  COUNT(*) FILTER (
    WHERE has_scope != (scope_json IS NOT NULL AND scope_json != '{}'::jsonb)
  ) AS mismatch
FROM jobs
WHERE org_id = '00000000-0000-0000-0000-000000000001'
  AND legacy IS NOT TRUE;
-- GATE: mismatch = 0
*/

-- Gate 4 (field semantics pre-check — run BEFORE read-path switch):
-- Confirms totalIncGST is the populated field; total and grandTotal should be near-zero.
/*
SELECT
  COUNT(*) AS total_jobs,
  COUNT(*) FILTER (
    WHERE pricing_json->>'totalIncGST' IS NOT NULL
      AND (pricing_json->>'totalIncGST')::numeric > 0
  ) AS has_total_inc_gst,
  COUNT(*) FILTER (WHERE pricing_json->>'total' IS NOT NULL)      AS has_total_field,
  COUNT(*) FILTER (WHERE pricing_json->>'grandTotal' IS NOT NULL) AS has_grand_total_field
FROM jobs
WHERE org_id = '00000000-0000-0000-0000-000000000001'
  AND legacy IS NOT TRUE
  AND status NOT IN ('draft', 'cancelled');
-- GATE: has_total_inc_gst >> has_total_field AND has_total_inc_gst >> has_grand_total_field
-- If has_grand_total_field is unexpectedly high, investigate before switching read sites.
*/
