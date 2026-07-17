-- jobs.quoted_value — lean generated column over pricing_json (M1, 2026-07-17)
--
-- Purpose:
--   Nine server-side call sites select jobs.quoted_value, which has never
--   existed. PostgREST rejects the whole request with 400 (42703 undefined
--   column), so each of those queries returns null and the caller — which
--   never checks the error — silently degrades to zero rows / $0.
--
--   The job's dollar value currently lives only inside the fat pricing_json
--   blob under key `totalIncGST`. Captain's ruled direction (2026-07-17) is a
--   real lean column rather than teaching every caller to read the JSON.
--
--   A STORED generated column is used because it is auto-maintained, needs no
--   backfill UPDATE, no trigger, and no tool changes: it materialises on ADD
--   and stays correct on every subsequent write to pricing_json.
--
-- Key naming:
--   Verified against live data 2026-07-17: `totalIncGST` is the only variant
--   actually present (1,701 of 2,262 jobs; all JSON type `number`; zero
--   non-castable values). The scoping tools are nonetheless inconsistent in
--   source (patio-tool and fence-designer also contain `totalIncGst`, and
--   secureworks-ux additionally `total_inc_gst`), so the expression falls
--   back across those variants to stay correct if such a write ever lands.
--
-- Safety:
--   Additive only. Nullable, no default, no existing row rewritten by hand.
--   The column is GENERATED, so it cannot be written to directly — any INSERT
--   or UPDATE naming quoted_value will be rejected. No current writer does.
--
--   The jsonb_typeof guard is load-bearing: a bare (pricing_json ->
--   'totalIncGST')::numeric raises on a non-numeric JSON value, and because
--   the expression is evaluated on every write that would turn a bad
--   pricing_json into a failed job save. The CASE yields NULL instead.
--   All functions used are IMMUTABLE, as generated columns require.
--
-- Expected effect on apply:
--   1,701 rows populate immediately, summing to ~$6,809,641.22.
--   561 rows have a pricing_json carrying no total key and stay NULL.
--
-- Rollback:
--   ALTER TABLE public.jobs DROP COLUMN quoted_value;

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS quoted_value numeric
  GENERATED ALWAYS AS (
    CASE
      WHEN jsonb_typeof(pricing_json -> 'totalIncGST')   = 'number'
        THEN (pricing_json ->> 'totalIncGST')::numeric
      WHEN jsonb_typeof(pricing_json -> 'totalIncGst')   = 'number'
        THEN (pricing_json ->> 'totalIncGst')::numeric
      WHEN jsonb_typeof(pricing_json -> 'total_inc_gst') = 'number'
        THEN (pricing_json ->> 'total_inc_gst')::numeric
      ELSE NULL
    END
  ) STORED;

COMMENT ON COLUMN public.jobs.quoted_value IS
  'Quoted job value inc GST, generated from pricing_json (totalIncGST, with '
  'totalIncGst / total_inc_gst fallbacks). Read-only: maintained by Postgres, '
  'write pricing_json instead. Added M1 2026-07-17.';
