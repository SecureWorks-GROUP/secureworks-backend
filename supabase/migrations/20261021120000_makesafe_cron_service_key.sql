-- The make-safe email reconcile and canary crons post the cleaned service key.
--
-- trigger_makesafe_reconcile(text) (crons makesafe-reconcile-d1, -d2, -d3 and
-- makesafe-canary-d4) and trigger_makesafe_status_canary() (cron
-- makesafe-status-canary) read vault.decrypted_secrets 'service_role_key' raw.
-- That secret is stored line-wrapped (20260717000001_cron_vault_service_key.sql,
-- "WHITESPACE DEFENCE"), so the raw read is a malformed bearer and ops-api
-- answers 401 on every run: the reconcile jobs have never got through, and the
-- canaries still 401 after #1125 admitted their service-role claim.
-- public.sw_service_key() strips the whitespace and checks the JWT shape; it is
-- what trigger_job_work_order_auto_issue posts, and that cron gets 200.
--
-- Each body changes in one place only: the vault read becomes
-- `'Bearer ' || public.sw_service_key()`. The makesafe_cron_enabled() gate, URL,
-- body, security definer, search_path, grants and comments are unchanged
-- (CREATE OR REPLACE keeps the comments; the grants are restated below exactly
-- as production holds them). No schedule changes.
-- Rollback: supabase/rollbacks/20261021120000_makesafe_cron_service_key_down.sql.

CREATE OR REPLACE FUNCTION public.trigger_makesafe_reconcile(p_action text) RETURNS void AS $$
BEGIN
  -- M4 — hard gate: no-op until an owner enables the cron. Applying this migration
  -- registers the D1/D2/D3/D4 schedules but does NOT start reconcile/Graph traversal.
  IF NOT public.makesafe_cron_enabled() THEN
    RAISE NOTICE 'trigger_makesafe_reconcile(%): cron gate disabled; skipping', p_action;
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=' || p_action,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public.sw_service_key()
    ),
    body := '{}'::jsonb
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.trigger_makesafe_status_canary()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.makesafe_cron_enabled() THEN
    RAISE NOTICE 'trigger_makesafe_status_canary: cron gate disabled; skipping';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=makesafe_status_canary',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public.sw_service_key()
    ),
    body := '{}'::jsonb
  );
END;
$$;

-- The grants production already holds, restated so the migration stands alone.
REVOKE ALL ON FUNCTION public.trigger_makesafe_reconcile(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trigger_makesafe_status_canary() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_makesafe_reconcile(text) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.trigger_makesafe_status_canary() TO service_role, postgres;
