-- ════════════════════════════════════════════════════════════
-- MAKE-SAFE INTAKE — SLA latency snapshot on the health record (B5)
-- Mission: fix/makesafe-board-hardening (zero-mistakes wave 2B)
-- ════════════════════════════════════════════════════════════
--
-- The email->board-card path is a 2-minute cron, but until now the ONLY freshness
-- signal was last_scan_at (written on a completed scan) — there was no arrival->card
-- latency metric, so the 2-min cadence could not be PROVEN daily. This adds a
-- per-scan latency snapshot (email received_at -> draft created_at delta, p50/p95/max
-- + sample count) plus the last scan's capped-candidate count, folded into the
-- existing single-row makesafe_intake_health so the one-call intake_health action can
-- assert the cadence. The 24h rolling latency is computed on READ in intake_health
-- from the per-draft created_at/received_at columns (same "24h rollups on read"
-- pattern as the cost ledger) — this ledger holds the last-scan snapshot only.
--
-- Additive + idempotent (safe on a plain `db push`; a re-apply is a no-op). No
-- behaviour change; the intake scan simply writes a few more columns.

ALTER TABLE public.makesafe_intake_health
  -- Last-scan email-received -> draft-created latency, in seconds (overwritten every run).
  ADD COLUMN IF NOT EXISTS last_scan_latency_p50_sec      numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_scan_latency_p95_sec      numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_scan_latency_max_sec      numeric NOT NULL DEFAULT 0,
  -- How many drafts contributed to the latency snapshot this scan (0 = quiet scan).
  ADD COLUMN IF NOT EXISTS last_scan_latency_samples      integer NOT NULL DEFAULT 0,
  -- Candidates deferred past the per-run scan budget this run (>0 = a backlog draining
  -- over multiple cycles; a sustained non-zero is the SLA-slip early warning).
  ADD COLUMN IF NOT EXISTS last_scan_capped_candidates    integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.makesafe_intake_health.last_scan_latency_p95_sec IS
  'B5 SLA: p95 of (draft created_at - email received_at) over drafts created in the
   most recent scan, in seconds. Written every run so the 2-minute email->card cadence
   is provable from the one-call intake_health action. 0 on a scan that created no drafts.';
COMMENT ON COLUMN public.makesafe_intake_health.last_scan_capped_candidates IS
  'B5 SLA: candidates skipped past MAKESAFE_INTAKE_SCAN_MAX_UNPROCESSED this run. A
   sustained non-zero means a backlog is draining over several cycles (latency slipping).';
