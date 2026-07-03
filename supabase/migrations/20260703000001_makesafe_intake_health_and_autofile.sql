-- ════════════════════════════════════════════════════════════
-- MAKE-SAFE INTAKE — fail-loud health record + auto-file kill switch
-- Mission: makesafe/intake-resurrect-harden (Auto-Intake v2 Wave 1 M1)
-- ════════════════════════════════════════════════════════════
--
-- Two changes, both additive and safe to apply on a plain `db push`:
--
--   1. auto_file_enabled — the DB kill switch for the internal auto-file gate
--      (Captain D1: auto-file from day one; default TRUE). Extends the existing
--      single-row makesafe_cron_settings. Flipping this to FALSE makes the intake
--      scan fall back to drafts-only WITHOUT a redeploy — one UPDATE, live in the
--      next 2-minute cycle.
--
--   2. makesafe_intake_health — a single-row DEGRADATION record so the v1 sin
--      (a dead ANTHROPIC_API_KEY producing silent empty extractions for weeks)
--      can never be silent again. scanSesMakesafes writes this row every run:
--      extraction_status ok|degraded, why, since-when, last scan/extraction times,
--      and the last-run draft/auto-file counts. The `intake_health` read action
--      surfaces it as the one-call health check for the terminal skill + morning
--      report.
--
-- Both tables are service-role only (same posture as makesafe_cron_settings and
-- the rest of the email-sync estate). Idempotent; re-applying is a no-op.

-- ── 1. auto-file kill switch on the existing cron-settings single row ──
ALTER TABLE public.makesafe_cron_settings
  ADD COLUMN IF NOT EXISTS auto_file_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.makesafe_cron_settings.auto_file_enabled IS
  'Auto-Intake v2 kill switch (Captain D1). When TRUE (default) the intake scan may
   auto-approve clean, high-confidence work-order drafts through the internal gate.
   Set FALSE to fall back to drafts-only with no redeploy.';

-- Helper mirrors makesafe_cron_enabled(): a STABLE, service-role-only read the
-- edge function / cron layer can call without exposing the table. Defaults TRUE
-- when the row is somehow absent (fail-OPEN to the Captain-locked default, since a
-- missing row must not silently disable the day-one auto-file decision).
CREATE OR REPLACE FUNCTION public.makesafe_auto_file_enabled() RETURNS boolean AS $$
  SELECT COALESCE(
    (SELECT auto_file_enabled FROM public.makesafe_cron_settings WHERE id = true),
    true
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.makesafe_auto_file_enabled() FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION public.makesafe_auto_file_enabled() FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION public.makesafe_auto_file_enabled() FROM authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.makesafe_auto_file_enabled() TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.makesafe_auto_file_enabled() TO postgres';
END $$;

-- ── 2. single-row intake extraction health / degradation record ──
CREATE TABLE IF NOT EXISTS public.makesafe_intake_health (
  id                             boolean PRIMARY KEY DEFAULT true CHECK (id),  -- single-row guard
  -- extraction_status: ok | degraded | unknown (unknown = never scanned yet).
  extraction_status              text NOT NULL DEFAULT 'unknown'
    CHECK (extraction_status IN ('ok', 'degraded', 'unknown')),
  -- degraded_reason: key_unset | auth_failed | null. WHY the classifier is down.
  degraded_reason                text,
  -- degraded_since: set on the ok->degraded transition, cleared on degraded->ok.
  -- Answers "how long has the key been dead" at a glance.
  degraded_since                 timestamptz,
  last_scan_at                   timestamptz,
  last_successful_extraction_at  timestamptz,
  -- Last-run observability (24h rollups are computed on read in intake_health).
  last_scan_drafts_created       integer NOT NULL DEFAULT 0,
  last_scan_auto_filed           integer NOT NULL DEFAULT 0,
  updated_at                     timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.makesafe_intake_health (id, extraction_status)
VALUES (true, 'unknown')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.makesafe_intake_health ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.makesafe_intake_health TO service_role;
DROP POLICY IF EXISTS service_role_all ON public.makesafe_intake_health;
CREATE POLICY service_role_all ON public.makesafe_intake_health
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.makesafe_intake_health IS
  'Auto-Intake v2 fail-loud record. scanSesMakesafes writes this single row every
   run. extraction_status=degraded (reason key_unset|auth_failed) whenever the
   ANTHROPIC_API_KEY is absent or the classifier call fails auth, so a dead key is
   loud (a needs_review docket + this banner), never a silent empty draft. Read via
   the ops-api intake_health action.';
