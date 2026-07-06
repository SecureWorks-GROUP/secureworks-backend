-- ════════════════════════════════════════════════════════════
-- MAKE-SAFE INTAKE — cost ledger columns on the health record
-- Mission: makesafe/intake-cost-hardening (Auto-Intake v2 Wave 1 M1.5)
-- ════════════════════════════════════════════════════════════
--
-- Extends the single-row makesafe_intake_health (from M1's
-- 20260703000001_makesafe_intake_health_and_autofile.sql) with a token/cost ledger so
-- the effect of the M1.5 cost levers (local PDF text extraction, per-builder template
-- parsers, prompt caching) is measurable, not asserted.
--
-- Two column groups, both additive and idempotent (safe on a plain `db push`, and a
-- re-apply is a no-op):
--   1. last_scan_*  — the token counts + call/skip split of the MOST RECENT scan.
--   2. total_*      — monotonically-accumulating lifetime running counters, so a
--                     cheap sum is always available without scanning the drafts table.
--
-- The 24-hour dashboard figures (estimated_cost_usd_24h, model_calls_24h,
-- model_skip_rate) are computed on READ in the intake_health action from the per-draft
-- extraction_json.cost records — this ledger holds the last-scan snapshot + lifetime
-- totals only. No behaviour changes; the intake scan simply writes more columns.

ALTER TABLE public.makesafe_intake_health
  -- Last-scan snapshot (overwritten every run).
  ADD COLUMN IF NOT EXISTS last_scan_model_calls          integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_scan_model_skips          integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_scan_input_tokens         bigint  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_scan_output_tokens        bigint  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_scan_cache_read_tokens    bigint  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_scan_cache_write_tokens   bigint  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_scan_estimated_cost_usd   numeric NOT NULL DEFAULT 0,
  -- Lifetime running counters (incremented every run).
  ADD COLUMN IF NOT EXISTS total_model_calls              bigint  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_model_skips              bigint  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_input_tokens             bigint  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_output_tokens            bigint  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_cache_read_tokens        bigint  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_cache_write_tokens       bigint  NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.makesafe_intake_health.last_scan_model_skips IS
  'Auto-Intake v2 M1.5 cost ledger: drafts in the last scan whose fields were parsed
   deterministically (template-first), so the Haiku classifier call was skipped
   entirely. Higher = cheaper.';
COMMENT ON COLUMN public.makesafe_intake_health.total_cache_read_tokens IS
  'Auto-Intake v2 M1.5 cost ledger: lifetime cache-read input tokens (billed at 0.1x)
   from prompt caching on the classifier''s static instruction prefix.';
