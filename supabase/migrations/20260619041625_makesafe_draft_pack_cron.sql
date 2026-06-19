-- ════════════════════════════════════════════════════════════
-- MAKE-SAFE REVIEW & SEND — Draft Pack cron activation (apply-LAST / gated)
-- Mission: makesafe-review-send-2026-06-19
-- ════════════════════════════════════════════════════════════
--
-- This registers the automatic Draft Pack batch runner Marnin asked for:
-- when a make-safe trade report lands on the board, ops-api?action=
-- draft_makesafe_report_pack_due finds due jobs and runs the Claude Draft Pack
-- path to produce draft-only review artefacts (Make Safe report PDF + Xero DRAFT
-- invoice + draft invoice PDF attachment).
--
-- SAFETY / APPLY-LAST:
--   - Registering this migration does NOT start automation by itself.
--   - The trigger no-ops while public.makesafe_cron_settings.cron_enabled=false.
--   - The ops-api action is routine allow-listed for draft/render/attach only.
--   - Auth follows the existing make-safe cron pattern: Vault service key first,
--     then the local _sw_service_key() helper used by the deployed cron triggers.
--   - It never calls makesafe_send_pack, never authorises a Xero invoice, never
--     sends email, never closes a job, and never writes a MAKESAFE_PACK_SENT marker.
--
-- To go live, after edge deploy + manual dry-run smoke + owner approval, use the
-- existing owner gate:
--   UPDATE public.makesafe_cron_settings
--      SET cron_enabled = true, enabled_at = now(), enabled_by = '<owner>';

CREATE OR REPLACE FUNCTION public.trigger_makesafe_draft_pack_due() RETURNS void AS $$
DECLARE
  svc_key text;
BEGIN
  -- M4 hard gate: schedule is inert until the owner enables make-safe cron.
  IF NOT public.makesafe_cron_enabled() THEN
    RAISE NOTICE 'trigger_makesafe_draft_pack_due: cron gate disabled; skipping';
    RETURN;
  END IF;

  BEGIN
    SELECT decrypted_secret INTO svc_key
      FROM vault.decrypted_secrets
      WHERE name = 'service_role_key'
      LIMIT 1;
  EXCEPTION
    WHEN undefined_table OR undefined_schema THEN
      svc_key := NULL;
  END;

  svc_key := COALESCE(NULLIF(svc_key, ''), public._sw_service_key());

  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=draft_makesafe_report_pack_due',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || svc_key
    ),
    body := jsonb_build_object(
      'limit', 5,
      'pack_kind', 'main',
      'operator', 'makesafe draft pack cron'
    )
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.trigger_makesafe_draft_pack_due IS
  'Gated pg_cron trigger for ops-api draft_makesafe_report_pack_due. Produces draft-only MakeSafe review artefacts; never sends, authorises, closes, or writes pack-sent markers.';

DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.trigger_makesafe_draft_pack_due() FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION public.trigger_makesafe_draft_pack_due() FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION public.trigger_makesafe_draft_pack_due() FROM authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.trigger_makesafe_draft_pack_due() TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.trigger_makesafe_draft_pack_due() TO postgres';
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('makesafe-draft-pack-due')
    FROM cron.job WHERE jobname = 'makesafe-draft-pack-due';
END $$;

-- Every 5 minutes so trade report -> review cockpit is quick, while the action
-- itself scans narrowly and no-ops when nothing is due.
SELECT cron.schedule(
  'makesafe-draft-pack-due',
  '*/5 * * * *',
  $$SELECT public.trigger_makesafe_draft_pack_due()$$
);
