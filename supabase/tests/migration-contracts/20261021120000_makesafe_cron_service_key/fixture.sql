-- Included inside a transaction the caller rolls back. Stand-ins for pg_net
-- (records each post) and Vault (holds 'service_role_key' line-wrapped, as
-- production stores it, so it differs from public.sw_service_key()), the gate
-- switched on, then every make-safe cron's call as cron.job runs it. Each
-- expected row is the ops-api action URL and body that cron posts.
CREATE SCHEMA net;
CREATE TABLE net.calls (n serial, url text, headers jsonb, body jsonb);
CREATE FUNCTION net.http_post(url text, headers jsonb DEFAULT '{}'::jsonb,
  body jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000) RETURNS bigint
LANGUAGE sql AS $$
  INSERT INTO net.calls (url, headers, body) VALUES (url, headers, body);
  SELECT 1::bigint
$$;
CREATE SCHEMA vault;
CREATE TABLE vault.decrypted_secrets (name text, decrypted_secret text);
INSERT INTO vault.decrypted_secrets VALUES
  ('service_role_key', E'contract-raw-vault-\n  key-line-wrapped');
CREATE OR REPLACE FUNCTION public.makesafe_cron_enabled() RETURNS boolean
  LANGUAGE sql AS $$ SELECT true $$;

SELECT public.trigger_makesafe_reconcile('makesafe_email_reconcile');
SELECT public.trigger_makesafe_reconcile('makesafe_email_reconcile_inventory');
SELECT public.trigger_makesafe_reconcile('makesafe_email_reconcile&mode=D3');
SELECT public.trigger_makesafe_reconcile('makesafe_email_canary');
SELECT public.trigger_makesafe_status_canary();
SELECT public.trigger_makesafe_portal_recheck();
SELECT public.trigger_makesafe_sent_mirror();
SELECT public.trigger_makesafe_story_recompute();
SELECT public.trigger_makesafe_status_shadow_refresh();

CREATE TEMP TABLE expected_calls (n integer, url text, body jsonb);
INSERT INTO expected_calls
SELECT e.n, 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=' || e.action, e.body
  FROM (VALUES
    (1, 'makesafe_email_reconcile', '{}'::jsonb),
    (2, 'makesafe_email_reconcile_inventory', '{}'::jsonb),
    (3, 'makesafe_email_reconcile&mode=D3', '{}'::jsonb),
    (4, 'makesafe_email_canary', '{}'::jsonb),
    (5, 'makesafe_status_canary', '{}'::jsonb),
    (6, 'makesafe_portal_recheck_enqueue', '{"min_interval_hours": 6}'::jsonb),
    (7, 'makesafe_sent_mirror', '{}'::jsonb),
    (8, 'makesafe_story_recompute', '{"stale_hours": 24}'::jsonb),
    (9, 'makesafe_status_shadow_refresh', '{}'::jsonb)
  ) AS e(n, action, body);
