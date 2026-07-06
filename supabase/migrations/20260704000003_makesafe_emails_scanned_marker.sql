-- ════════════════════════════════════════════════════════════
-- MAKE-SAFE INTAKE — emails processed-marker (extract-at-most-once)
-- Mission: makesafe/intake-scanned-marker (Auto-Intake v2 — cost leak fix)
-- ════════════════════════════════════════════════════════════
--
-- THE LEAK THIS CLOSES
-- --------------------
-- The 2-minute intake cron re-EXTRACTS the same emails every cycle when they never
-- produce a draft. A NON-work-order email (a pricing question, a "please disregard",
-- a clarification) passes the sender/subject candidate filter, reaches the Haiku
-- classifier call, is correctly classified not_a_work_order, and is then dropped by
-- the work-order gate WITHOUT creating a draft. With no draft, the draft-level dedup
-- has nothing to match, so the same email is re-filtered-in and re-extracted on the
-- NEXT cycle, forever (measured: +4 model calls per scan, 0 new drafts). ~$8/day.
--
-- THE FIX
-- -------
-- A per-email processed marker on the emails projection. scanSesMakesafes SKIPS an
-- email whose makesafe_scanned_at is already set (no model call), and SETS it after a
-- SUCCESSFUL scan (the model returned a valid result OR a deterministic template parse
-- succeeded) — whether or not the email became a draft. It is deliberately NOT set on
-- an auth/transient extraction failure, so a dead-key email retries when the key
-- recovers (preserving the fail-loud backfill path). Each email is extracted at most
-- once.
--
-- Additive + idempotent: nullable column, safe on a plain `db push`, re-apply is a
-- no-op. The scan reads it pre-migration-safely (falls back to the base select if the
-- column is absent), so this migration can be hand-applied AFTER the code auto-deploys.

ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS makesafe_scanned_at timestamptz;

COMMENT ON COLUMN public.emails.makesafe_scanned_at IS
  'Auto-Intake v2 extract-at-most-once marker. Set by scanSesMakesafes AFTER a
   successful extraction/classification of this email (model returned a valid result
   or a template parse succeeded), whether or not a draft was created. A set value
   makes the next scan SKIP the email with no model call. Left NULL on auth/transient
   extraction failure so the email retries when the key recovers.';

-- Partial index: the scan only ever needs the UNSCANNED rows in the ses@ window, so a
-- WHERE makesafe_scanned_at IS NULL index keeps that lookup cheap as the marked set grows.
CREATE INDEX IF NOT EXISTS idx_emails_makesafe_unscanned
  ON public.emails (mailbox, received_at)
  WHERE makesafe_scanned_at IS NULL;
