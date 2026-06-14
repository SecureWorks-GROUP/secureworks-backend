-- ════════════════════════════════════════════════════════════
-- MAKE-SAFE EMAIL RECONCILIATION — cron enable (Phase 2, Stage C / apply-LAST)
-- Mission: makesafe-live-truth-2026-06-14
-- ════════════════════════════════════════════════════════════
--
-- APPLY-LAST migration. Enables the reconciliation automation that turns silent
-- sync failures into self-detecting alerts:
--   1. makesafe-reconcile-d1   — */30  D1 reconcile diff (pipeline vs board)
--   2. makesafe-reconcile-d2   — daily D2 MANDATORY full-post inventory
--   3. makesafe-reconcile-d3   — daily D3 wider-window catch-up reconcile
--   4. makesafe-canary-d4      — */15  D4 canary check (within SLA)
--
-- Per MISSION.md Stage C, applied ONLY after:
--   - the schema migrations (…0001, …0003) are applied and verified,
--   - a manual read-only smoke run has passed (Stage B),
--   - Graph app-permission consent is confirmed by tenant admin,
--   - Marnin owner approval is given.
--
-- These call the ops-api reconciliation ACTIONS over HTTP with the vault
-- service_role key (same auth path as fn_process_payment_events; ops-api accepts
-- a Bearer service-role key). Idempotent: each cron.schedule is preceded by a
-- guarded unschedule. INERT until applied.
--
-- M4 GATE: applying this migration only REGISTERS the D1-D4 schedules. The trigger
-- function no-ops until an owner enables the gate (makesafe_cron_settings, defined
-- in 20260614000001). A plain `db push` therefore does NOT start reconcile / Graph
-- traversal. To go live (Stage C), after consent + approval:
--   UPDATE public.makesafe_cron_settings
--      SET cron_enabled = true, enabled_at = now(), enabled_by = '<owner>';

-- ── Trigger: invoke an ops-api reconciliation action over HTTP ──
CREATE OR REPLACE FUNCTION public.trigger_makesafe_reconcile(p_action text) RETURNS void AS $$
DECLARE
  svc_key text;
BEGIN
  -- M4 — hard gate: no-op until an owner enables the cron. Applying this migration
  -- registers the D1/D2/D3/D4 schedules but does NOT start reconcile/Graph traversal.
  IF NOT public.makesafe_cron_enabled() THEN
    RAISE NOTICE 'trigger_makesafe_reconcile(%): cron gate disabled; skipping', p_action;
    RETURN;
  END IF;
  SELECT decrypted_secret INTO svc_key
    FROM vault.decrypted_secrets
    WHERE name = 'service_role_key'
    LIMIT 1;

  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=' || p_action,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || svc_key
    ),
    body := '{}'::jsonb
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.trigger_makesafe_reconcile IS
  'Calls an ops-api make-safe reconciliation action (makesafe_email_reconcile /
   _inventory / _canary) via pg_net with the vault service key.';

-- ── Lock down the definer trigger (no anon/authenticated execute) ──
DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.trigger_makesafe_reconcile(text) FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION public.trigger_makesafe_reconcile(text) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION public.trigger_makesafe_reconcile(text) FROM authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.trigger_makesafe_reconcile(text) TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.trigger_makesafe_reconcile(text) TO postgres';
END $$;

-- ── Idempotent (re)schedule ──
DO $$
BEGIN
  PERFORM cron.unschedule('makesafe-reconcile-d1')
    FROM cron.job WHERE jobname = 'makesafe-reconcile-d1';
  PERFORM cron.unschedule('makesafe-reconcile-d2')
    FROM cron.job WHERE jobname = 'makesafe-reconcile-d2';
  PERFORM cron.unschedule('makesafe-reconcile-d3')
    FROM cron.job WHERE jobname = 'makesafe-reconcile-d3';
  PERFORM cron.unschedule('makesafe-canary-d4')
    FROM cron.job WHERE jobname = 'makesafe-canary-d4';
END $$;

-- D1 — reconcile diff every 30 min (frequent enough to catch dropped intake fast).
SELECT cron.schedule(
  'makesafe-reconcile-d1',
  '*/30 * * * *',
  $$SELECT public.trigger_makesafe_reconcile('makesafe_email_reconcile')$$
);

-- D2 — MANDATORY full-post inventory, daily at 17:30 UTC (01:30 AWST, off-peak).
SELECT cron.schedule(
  'makesafe-reconcile-d2',
  '30 17 * * *',
  $$SELECT public.trigger_makesafe_reconcile('makesafe_email_reconcile_inventory')$$
);

-- D3 — wider-window catch-up reconcile, daily at 17:45 UTC.
SELECT cron.schedule(
  'makesafe-reconcile-d3',
  '45 17 * * *',
  $$SELECT public.trigger_makesafe_reconcile('makesafe_email_reconcile&mode=D3')$$
);

-- D4 — canary check every 15 min (verify seeded synthetic markers within SLA).
SELECT cron.schedule(
  'makesafe-canary-d4',
  '*/15 * * * *',
  $$SELECT public.trigger_makesafe_reconcile('makesafe_email_canary')$$
);
