-- ════════════════════════════════════════════════════════════
-- CRON AUTH — source the service key at runtime, not from job text
-- Mission: system-speed M4 (2026-07-17)
-- ════════════════════════════════════════════════════════════
--
-- WHY
-- 11 pg_cron jobs embed a literal service-role JWT in cron.job.command
-- (added by 20260322000004_hardcode_cron_auth.sql). Anyone who can SELECT
-- cron.job reads a god-mode key, and Postgres echoes the command into the
-- statement logs on every run. This migration re-schedules all 11 so the
-- command text carries no secret: each job now calls a SECURITY DEFINER
-- trigger that fetches the key from vault at run time.
--
-- PRECEDENT
-- Pattern copied from 20260708000002_makesafe_portal_recheck_cron.sql and
-- 20260709000002_makesafe_hybrid_loop_cron.sql: a SECURITY DEFINER plpgsql
-- function reads vault.decrypted_secrets and calls net.http_post; the cron
-- command is a bare `SELECT public.trigger_x()`. The parameterised form
-- (one function, action passed in) follows trigger_makesafe_reconcile(text)
-- from 20260614000004_makesafe_email_reconcile_cron.sql.
--
-- WHY NOT current_setting
-- 20260322000003_fix_vault_and_cron.sql tried current_setting('app.settings.
-- service_role_key') inline in the cron command and it did not resolve in the
-- pg_cron background worker; 20260322000004 then hardcoded the key and left a
-- comment claiming "neither vault nor current_setting works". That comment is
-- wrong about vault: the make-safe crons above have read vault from inside a
-- SECURITY DEFINER function on this project since June. The definer wrapper is
-- what makes it work — the secret is read as the function owner, not as the
-- cron job's invoking role. This migration uses the proven form.
--
-- WHITESPACE DEFENCE (load-bearing — do not remove)
-- The vault secret `service_role_key` on this project is currently stored
-- line-wrapped: it is the correct key with 6 stray whitespace characters
-- (newlines + spaces) injected mid-token, so a raw read yields a malformed
-- Authorization header and the edge function replies 401. sw_service_key()
-- therefore strips whitespace and validates the JWT shape before returning.
-- A JWT is base64url + dots by definition and can never legally contain
-- whitespace, so the strip is safe; it also makes this migration a no-op-safe
-- improvement if the stored secret is later re-pasted cleanly.

-- ── Key accessor: vault → whitespace-stripped → shape-validated ──
CREATE OR REPLACE FUNCTION public.sw_service_key() RETURNS text AS $$
DECLARE
  v_key text;
BEGIN
  SELECT decrypted_secret INTO v_key
    FROM vault.decrypted_secrets
    WHERE name = 'service_role_key'
    LIMIT 1;

  IF v_key IS NULL THEN
    RAISE EXCEPTION 'sw_service_key: vault secret "service_role_key" not found';
  END IF;

  -- Repair line-wrapped pastes: a JWT never legally contains whitespace.
  v_key := regexp_replace(v_key, '\s', '', 'g');

  -- Fail loud rather than send a malformed bearer token and 401 silently.
  IF v_key !~ '^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'sw_service_key: vault secret "service_role_key" is not a well-formed JWT';
  END IF;

  RETURN v_key;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER
   SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.sw_service_key IS
  'Returns the service-role key from vault (whitespace-stripped, shape-validated).
   SECURITY DEFINER so pg_cron background workers can read the vault secret.
   Deliberately NOT granted to anon/authenticated: it returns a god-mode key.';

-- Lock the accessor down hard: postgres only. Nothing else needs it — the
-- trigger functions below are themselves SECURITY DEFINER and owned by the
-- same role, so they call it as the owner regardless of the caller.
REVOKE ALL ON FUNCTION public.sw_service_key() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sw_service_key() FROM anon;
REVOKE ALL ON FUNCTION public.sw_service_key() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sw_service_key() TO postgres;

-- ── Trigger: xero-sync actions (10 of the 11 jobs) ──
CREATE OR REPLACE FUNCTION public.trigger_xero_sync(p_action text) RETURNS void AS $$
BEGIN
  IF p_action !~ '^[a-z_]+$' THEN
    RAISE EXCEPTION 'trigger_xero_sync: invalid action %', p_action;
  END IF;

  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=' || p_action,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public.sw_service_key()
    ),
    body := '{}'::jsonb
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.trigger_xero_sync IS
  'Calls the xero-sync edge function for the given action via pg_net, with the
   service key sourced from vault at run time. Replaces 10 cron jobs that
   carried the key inline in cron.job.command (20260322000004).';

-- ── Trigger: system-health ──
CREATE OR REPLACE FUNCTION public.trigger_system_health() RETURNS void AS $$
BEGIN
  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/system-health',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public.sw_service_key()
    ),
    body := '{}'::jsonb
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.trigger_system_health IS
  'Calls the system-health edge function via pg_net with the vault service key.
   Replaces the inline-key cron job from 20260322000011_system_health_cron.sql.';

-- ── Lock down the definer triggers (matches the make-safe precedent) ──
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.trigger_xero_sync(text)',
    'public.trigger_system_health()'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO postgres', fn);
  END LOOP;
END $$;

-- ── Idempotent (re)schedule ──
-- Schedules are reproduced exactly as they run in production today (read from
-- cron.job on 2026-07-17), so cadence and jitter offsets are unchanged. Only
-- the command text changes: the key is gone from all 11.
DO $$
DECLARE
  j record;
BEGIN
  FOR j IN
    SELECT * FROM (VALUES
      ('xero-token-refresh',    '9-59/20 * * * *',  $cmd$SELECT public.trigger_xero_sync('token_refresh')$cmd$),
      ('xero-invoice-sync',     '4-59/15 * * * *',  $cmd$SELECT public.trigger_xero_sync('sync_invoices')$cmd$),
      ('xero-po-sync',          '8,38 * * * *',     $cmd$SELECT public.trigger_xero_sync('sync_purchase_orders')$cmd$),
      ('xero-reports-sync',     '3 22 * * *',       $cmd$SELECT public.trigger_xero_sync('sync_reports')$cmd$),
      ('xero-projects-sync',    '15 22 * * *',      $cmd$SELECT public.trigger_xero_sync('sync_projects')$cmd$),
      ('xero-tracking-pl-sync', '30 22 * * *',      $cmd$SELECT public.trigger_xero_sync('sync_tracking_pl')$cmd$),
      ('xero-bank-sync',        '45 22 * * *',      $cmd$SELECT public.trigger_xero_sync('sync_bank_balances')$cmd$),
      ('xero-payables-sync',    '50 22 * * *',      $cmd$SELECT public.trigger_xero_sync('sync_aged_payables')$cmd$),
      ('xero-suppliers-sync',   '55 22 * * *',      $cmd$SELECT public.trigger_xero_sync('sync_suppliers')$cmd$),
      ('contact-matching',      '6 19 * * *',       $cmd$SELECT public.trigger_xero_sync('match_contacts')$cmd$),
      ('system-health-check',   '21-59/30 * * * *', $cmd$SELECT public.trigger_system_health()$cmd$)
    ) AS t(jobname, schedule, command)
  LOOP
    PERFORM cron.unschedule(j.jobname) FROM cron.job WHERE cron.job.jobname = j.jobname;
    PERFORM cron.schedule(j.jobname, j.schedule, j.command);
  END LOOP;
END $$;

-- ── Verification (safe to run post-deploy; prints no key material) ──
-- Expect: zero rows.
--   SELECT jobname FROM cron.job
--   WHERE command ~ 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+';
