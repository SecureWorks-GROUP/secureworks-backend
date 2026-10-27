-- Contract for 20261021120000_makesafe_cron_service_key.sql: every make-safe
-- ops-api cron (email reconcile D1, D2, D3, email canary D4, status canary,
-- portal recheck, sent mirror, story recompute, status shadow refresh) posts
-- `Bearer <sw_service_key()>`, never the raw Vault secret, with its action URL
-- and body unchanged, and still does nothing while makesafe_cron_enabled() is
-- off. Fixture writes roll back.

-- 1. All six triggers exist, stay security definer with a fixed search_path,
--    and are closed to the browser roles.
DO $$
DECLARE
  sig text;
  f record;
BEGIN
  FOREACH sig IN ARRAY ARRAY[
    'public.trigger_makesafe_reconcile(text)',
    'public.trigger_makesafe_status_canary()',
    'public.trigger_makesafe_portal_recheck()',
    'public.trigger_makesafe_sent_mirror()',
    'public.trigger_makesafe_story_recompute()',
    'public.trigger_makesafe_status_shadow_refresh()'
  ]
  LOOP
    SELECT p.oid, p.prosecdef, p.proconfig INTO f
      FROM pg_proc p WHERE p.oid = to_regprocedure(sig);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'contract: % is missing', sig;
    END IF;
    IF NOT f.prosecdef OR NOT ('search_path=public, pg_temp' = ANY (f.proconfig)) THEN
      RAISE EXCEPTION 'contract: % must be security definer with a fixed search_path (%)', sig, f.proconfig;
    END IF;
    IF has_function_privilege('anon', f.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', f.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'contract: % is executable by anon or authenticated', sig;
    END IF;
    IF NOT has_function_privilege('service_role', f.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'contract: % is not executable by service_role', sig;
    END IF;
  END LOOP;
END $$;

-- 2. Gate off (the fixture): each returns without reaching net.http_post or
--    the Vault, neither of which exists here, so a call past the gate raises.
SELECT public.trigger_makesafe_reconcile('makesafe_email_reconcile');
SELECT public.trigger_makesafe_status_canary();
SELECT public.trigger_makesafe_portal_recheck();
SELECT public.trigger_makesafe_sent_mirror();
SELECT public.trigger_makesafe_story_recompute();
SELECT public.trigger_makesafe_status_shadow_refresh();

-- 3. Gate on, beside a Vault holding the line-wrapped raw secret: each cron
--    posts its own action and body with Bearer sw_service_key().
BEGIN;
\ir fixture.sql
DO $$
DECLARE
  c record;
BEGIN
  IF (SELECT array_agg(url ORDER BY n) FROM net.calls)
     IS DISTINCT FROM (SELECT array_agg(url ORDER BY n) FROM expected_calls) THEN
    RAISE EXCEPTION 'contract: the crons posted %', (SELECT array_agg(url ORDER BY n) FROM net.calls);
  END IF;
  FOR c IN SELECT a.url, a.headers, a.body, e.body AS expected_body
             FROM net.calls a JOIN expected_calls e USING (n) LOOP
    IF c.headers IS DISTINCT FROM jsonb_build_object(
         'Content-Type', 'application/json',
         'Authorization', 'Bearer ' || public.sw_service_key()) THEN
      RAISE EXCEPTION 'contract: % did not post Bearer sw_service_key() (posted %)', c.url, c.headers;
    END IF;
    IF c.body IS DISTINCT FROM c.expected_body THEN
      RAISE EXCEPTION 'contract: % posted body %, expected %', c.url, c.body, c.expected_body;
    END IF;
  END LOOP;
END $$;
ROLLBACK;
