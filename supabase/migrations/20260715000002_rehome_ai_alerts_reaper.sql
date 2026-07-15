-- ============================================================
-- Re-home the ai_alerts stale-alert reaper off daily-digest
-- ============================================================
-- Migration 20260715000001 unscheduled the daily-digest crons. That silently
-- took the stale-alert reaper with it: daily-digest/index.ts:2584 was the only
-- automated resolver of ai_alerts, and ai_alerts still has live writers
-- (ops-api trade issues / variation approvals / low satisfaction / scoper price
-- updates, telegram-bot keyword alerts). Left unreaped, alerts accumulate
-- forever: nothing but a human clicking dismiss/resolve in ops would ever clear
-- one, and every ai_alerts reader (ops-api dismiss/resolve, ops-ai and
-- agent-runner get_ai_alerts, system-health) sees the pile grow.
--
-- This reaper is HALF of what stops system-health Telegram-spamming the admin.
-- The other half lives in system-health itself, and both are required:
--
--   system-health's stale-alerts check goes 'critical' at >= 30 alerts older
--   than 48h and fires an unthrottled Telegram alert to ADMIN_CHAT_ID every 30
--   minutes. That check counted rows filtered ONLY on dismissed_at IS NULL — it
--   never looked at resolved_at. This reaper sets resolved_at and deliberately
--   leaves dismissed_at alone (parity with the digest, see below), so on its own
--   it would resolve alerts that STILL counted toward 'critical' and the spam
--   would fire anyway. system-health's count now also filters
--   resolved_at IS NULL, so what this reaper resolves actually drops out.
--
-- Change either side and the spam comes back: the reaper without the filter
-- resolves rows that still count; the filter without the reaper has nothing
-- setting resolved_at.
--
-- This re-homes that job as a standalone pg_cron job. Pure SQL: the original
-- was a single supabase-js .update() with no HTTP, so no edge function is
-- needed and there is no service-key handling to get wrong.
--
-- PARITY — this replicates daily-digest/index.ts:2584 exactly:
--   const staleDate = new Date(Date.now() - 7 * 86400000).toISOString()
--   await sb.from('ai_alerts')
--     .update({ resolved_at: new Date().toISOString() })
--     .eq('org_id', DEFAULT_ORG_ID)      -- 00000000-0000-0000-0000-000000000001
--     .is('dismissed_at', null)
--     .is('resolved_at', null)
--     .lt('created_at', staleDate)
-- Same 7-day age threshold, same org filter, same two IS NULL status filters,
-- and it sets resolved_at only — resolved_by is deliberately left NULL, exactly
-- as the digest did, so an auto-resolved alert stays distinguishable from one a
-- human resolved.

CREATE OR REPLACE FUNCTION public.resolve_stale_ai_alerts() RETURNS integer AS $$
DECLARE
  resolved_count integer;
BEGIN
  UPDATE ai_alerts
     SET resolved_at = now()
   WHERE org_id = '00000000-0000-0000-0000-000000000001'
     AND dismissed_at IS NULL
     AND resolved_at IS NULL
     AND created_at < now() - interval '7 days';

  GET DIAGNOSTICS resolved_count = ROW_COUNT;
  RETURN resolved_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;  -- B6: pin search_path on definer fn

COMMENT ON FUNCTION public.resolve_stale_ai_alerts IS
  'Auto-resolve ai_alerts older than 7 days that are neither dismissed nor resolved. Re-homed from daily-digest (index.ts:2584) when its crons were unscheduled. Returns the number of alerts resolved. Usage: SELECT resolve_stale_ai_alerts();';

-- ── B6: revoke execute from PUBLIC/anon/authenticated; grant only to
--    service_role + postgres. A SECURITY DEFINER function in public keeps
--    Postgres' default EXECUTE-to-PUBLIC grant and is exposed as a PostgREST
--    RPC, so without this any anon caller could mass-resolve every alert. ──
DO $$
DECLARE fn text := 'public.resolve_stale_ai_alerts()';
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC;', fn);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon;', fn);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated;', fn);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role;', fn);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO postgres;', fn);
END $$;

-- Guarded so re-running is a no-op (cron.schedule is idempotent on jobname,
-- but unschedule first to keep the pattern consistent with the rest of the repo).
DO $$
BEGIN
  PERFORM cron.unschedule('ai-alerts-stale-reaper')
    FROM cron.job WHERE jobname = 'ai-alerts-stale-reaper';
END $$;

-- Runs daily at 23:00 UTC (07:00 AWST) — the same slot the 'daily-digest' job
-- occupied, so the reaper keeps firing at the time it always has.
SELECT cron.schedule(
  'ai-alerts-stale-reaper',
  '0 23 * * *',
  $$SELECT public.resolve_stale_ai_alerts()$$
);
