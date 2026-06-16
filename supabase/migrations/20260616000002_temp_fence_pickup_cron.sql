-- ════════════════════════════════════════════════════════════
-- TEMP FENCE PICKUP — timer cron (gated; APPLY-LAST; convenience only)
-- Mission: temp-fence-pickup-2026-06-16
-- ════════════════════════════════════════════════════════════
--
-- WHAT THIS IS (and is NOT):
--   The authoritative "needs pickup" surfacing is DERIVED live on read
--   (ops-api deriveFenceHireState: status='out' AND hire_end_date <= today).
--   The system is correct even if this cron NEVER runs.
--   This cron is a CONVENIENCE writer that promotes the STORED column
--   out -> needs_pickup for any consumer that reads the column directly.
--   It performs NO invoice/billing action of any kind.
--
-- HARD GATE (mirrors 20260614000002_makesafe_email_sync_cron.sql):
--   The trigger function no-ops until an owner flips the SHARED make-safe cron
--   gate. Applying this migration only REGISTERS the schedule; a plain db push
--   does NOT start promoting anything. To go live (after approval):
--     UPDATE public.makesafe_cron_settings
--        SET cron_enabled = true, enabled_at = now(), enabled_by = '<owner>';
--   (Reuses makesafe_cron_settings / makesafe_cron_enabled() from
--    20260614000001_makesafe_email_sync_schema.sql.)
--
-- Idempotent: the promote is WHERE-guarded; re-running is a no-op once promoted.

-- ── Promote: out -> needs_pickup for jobs whose hire_end_date has arrived ──
-- Pure column write. No invoice, no Xero, no send, no allocation.
CREATE OR REPLACE FUNCTION public.promote_fence_hire_needs_pickup() RETURNS integer AS $$
DECLARE
  promoted integer;
BEGIN
  -- Hard gate: no-op unless an owner has enabled the shared make-safe cron.
  IF NOT public.makesafe_cron_enabled() THEN
    RAISE NOTICE 'promote_fence_hire_needs_pickup: cron gate disabled; skipping';
    RETURN 0;
  END IF;

  WITH promoted_rows AS (
    UPDATE public.makesafe_job_details
       SET fence_hire_status = 'needs_pickup',
           pickup_due_logged_at = COALESCE(pickup_due_logged_at, now()),
           updated_at = now()
     WHERE fence_hire_status = 'out'
       AND hire_end_date IS NOT NULL
       AND hire_end_date <= (now() AT TIME ZONE 'Australia/Perth')::date
    RETURNING job_id
  )
  SELECT count(*) INTO promoted FROM promoted_rows;

  RAISE NOTICE 'promote_fence_hire_needs_pickup: promoted %', promoted;
  RETURN promoted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.promote_fence_hire_needs_pickup IS
  'Daily timer: promote temp-fence hires from out -> needs_pickup once hire_end_date is reached (Perth date). Gated by makesafe_cron_enabled(). Convenience only; the live ops-api read derives the same state. No billing action.';

-- ── Lock down the definer function (same pattern as the other cron triggers) ──
DO $$
DECLARE fn text := 'public.promote_fence_hire_needs_pickup()';
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC;', fn);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon;', fn);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated;', fn);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role;', fn);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO postgres;', fn);
END $$;

-- ── Idempotent (re)schedule: daily 17:30 UTC (01:30 AWST), off-peak ──
DO $$
BEGIN
  PERFORM cron.unschedule('fence-hire-needs-pickup')
    FROM cron.job WHERE jobname = 'fence-hire-needs-pickup';
END $$;

SELECT cron.schedule(
  'fence-hire-needs-pickup',
  '30 17 * * *',
  $$SELECT public.promote_fence_hire_needs_pickup()$$
);
