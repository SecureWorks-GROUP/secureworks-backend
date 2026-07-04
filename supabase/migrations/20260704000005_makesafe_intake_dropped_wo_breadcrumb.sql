-- ════════════════════════════════════════════════════════════
-- MAKE-SAFE INTAKE — dropped-WO breadcrumb on the health record (A3)
-- Mission: fix/makesafe-reextract-and-notify-2026-07-04 (zero-mistakes wave 2C)
-- ════════════════════════════════════════════════════════════
--
-- ROOT CAUSE (see wave2-reextract-diagnosis.json): a genuine work order whose
-- INSERT into makesafe_intake_drafts failed on the (org_id, graph_message_id)
-- UNIQUE key was SILENTLY dropped with only a console.log — no board trace, no
-- health signal, so the #273 extraction-health alarm never tripped. This adds a
-- LAST-SCAN breadcrumb the alarm can read so a dropped-after-valid-extraction WO
-- can never vanish with only a console.log again.
--
--   * last_scan_insert_conflicts_healed — 23505 collisions this run whose occupying
--     row was a NON-LIVE shell (superseded/rejected) and was safely updated in place.
--     Benign (recovered); recorded for observability, does NOT raise the alarm.
--   * last_scan_insert_conflicts_live — 23505 collisions this run whose occupying row
--     was LIVE (dedup failed upstream). NOT clobbered. RAISES the alarm.
--   * last_scan_dropped_wo — inserts that failed for any OTHER reason after a valid
--     extraction (a real WO lost). RAISES the alarm.
--   * total_* lifetime counters + last-dropped ref/timestamp for forensics.
--
-- Additive + idempotent (safe on a plain `db push`; a re-apply is a no-op). No
-- behaviour change until the code that writes these columns is deployed; the health
-- writer already falls back to base columns when the ledger columns are absent.

ALTER TABLE public.makesafe_intake_health
  -- Last-scan breadcrumb (overwritten every run; 0 on a clean scan so the alarm clears).
  ADD COLUMN IF NOT EXISTS last_scan_insert_conflicts_healed integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_scan_insert_conflicts_live   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_scan_dropped_wo              integer NOT NULL DEFAULT 0,
  -- Lifetime forensics (monotonic).
  ADD COLUMN IF NOT EXISTS total_insert_conflicts_healed     integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_insert_conflicts_live       integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_dropped_wo                  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dropped_wo_last_at                timestamptz,
  ADD COLUMN IF NOT EXISTS dropped_wo_last_ref               text,
  -- Empty-feed anomaly: the freshest INBOUND (non-own-domain) ses@ email the scan saw.
  -- If a degraded Graph mirror returns 200-with-nothing this stops advancing, and the
  -- alarm trips during Perth business hours (own outbound is excluded so our sends can't
  -- mask a dead feed).
  ADD COLUMN IF NOT EXISTS last_inbound_email_at             timestamptz;

COMMENT ON COLUMN public.makesafe_intake_health.last_scan_dropped_wo IS
  'A3: work orders dropped this scan (insert failed after a valid extraction). >0 raises
   the makesafeExtractionHealthAlarm so a genuine WO can never vanish with only a console.log.';
COMMENT ON COLUMN public.makesafe_intake_health.last_scan_insert_conflicts_live IS
  'A3: (org_id, graph_message_id) unique-key collisions this scan where the occupying row
   was LIVE (dedup failed upstream). NOT clobbered; raises the alarm for investigation.';
COMMENT ON COLUMN public.makesafe_intake_health.last_scan_insert_conflicts_healed IS
  'A3: unique-key collisions this scan where the occupying row was a non-live shell
   (superseded/rejected) and was safely re-populated in place. Benign; observability only.';
