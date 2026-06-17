-- ══════════════════════════════════════════════════════════════
-- Migration: jobs lean stored columns
-- Timestamp: 20260617000003
-- Branch: perf/lean-columns-2026-06-17
-- Contract: coding/work/missions/scope-ops-speed-2026-06-17/CONTRACT.md
--
-- APPLY ORDER (gated — General + Marnin gate each step):
--   1. Apply this migration (adds columns with safe defaults)
--   2. Run the one-shot backfill SQL below (separate SQL editor run)
--   3. Run all three gate verification queries — all must return 0 mismatches
--   4. Only THEN apply the read-path switch (pipeline/opsSummary/updateJobStatus)
--      Those read-path changes are NOT in this migration; they come in a subsequent PR.
--
-- DO NOT apply the backfill or read-path switch in the same step as this migration.
-- ══════════════════════════════════════════════════════════════


-- ── 1. Add lean stored columns to jobs ────────────────────────────────────────
--
-- quoted_amount: canonical INC-GST total from pricing_json.totalIncGST.
--   NULL = job has no pricing yet (draft or unscoped).
--   Written by ghl-proxy save_scope when meta.pricing_json is present.
--
-- has_scope: true when scope_json is non-null and non-empty object.
--   Written by ghl-proxy save_scope on every scope save.
--   Replaces the Object.keys(scope_json).length > 0 check in search_jobs + opportunities.
--
-- neighbour_count: count of fencing neighbours from pricing_json.neighbour_splits.neighbours.
--   Always 0 for non-fencing jobs.
--   Written by ghl-proxy save_scope when meta.pricing_json is present.
--   Replaces the pricing_json TOAST decompress in pipeline() for the neighbour badge.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS quoted_amount  numeric(12,2);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS has_scope      boolean NOT NULL DEFAULT false;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS neighbour_count smallint NOT NULL DEFAULT 0;


-- ══════════════════════════════════════════════════════════════
-- ONE-SHOT BACKFILL — run SEPARATELY in Supabase SQL editor after migration is applied.
-- Do NOT include in a transaction block. Run as standalone statement.
-- Expected runtime: < 5 seconds on ~1,920 rows.
--
-- Copy from here to the closing semicolon and paste into the SQL editor:
-- ══════════════════════════════════════════════════════════════
/*
UPDATE jobs
SET
  quoted_amount = (pricing_json->>'totalIncGST')::numeric,
  has_scope     = (scope_json IS NOT NULL AND scope_json != '{}'::jsonb),
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
-- GATE VERIFICATION QUERIES — run after backfill, all must return 0 mismatches.
-- All gates must pass before any read-site is switched to use these columns.
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

-- Gate 4 (field semantics pre-check — run BEFORE Stage C read-path switch):
-- Confirm totalIncGST is the populated field; total and grandTotal should be near-zero counts.
/*
SELECT
  COUNT(*) AS total_jobs,
  COUNT(*) FILTER (WHERE pricing_json->>'totalIncGST' IS NOT NULL
    AND (pricing_json->>'totalIncGST')::numeric > 0) AS has_total_inc_gst,
  COUNT(*) FILTER (WHERE pricing_json->>'total' IS NOT NULL) AS has_total_field,
  COUNT(*) FILTER (WHERE pricing_json->>'grandTotal' IS NOT NULL) AS has_grand_total_field
FROM jobs
WHERE org_id = '00000000-0000-0000-0000-000000000001'
  AND legacy IS NOT TRUE
  AND status NOT IN ('draft', 'cancelled');
-- GATE: has_total_inc_gst >> has_total_field, has_total_inc_gst >> has_grand_total_field
-- If has_grand_total_field is unexpectedly high, investigate before adopting totalIncGST as sole stored value.
*/
