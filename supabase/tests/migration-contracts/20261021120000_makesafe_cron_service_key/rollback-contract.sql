-- After the down migration all six triggers post the raw Vault secret again,
-- as production held them before 20261021120000, with the same action URLs and
-- bodies, still gated, and still closed to the browser roles.
DO $$
DECLARE
  sig text;
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
    IF has_function_privilege('anon', to_regprocedure(sig)::oid, 'EXECUTE')
       OR has_function_privilege('authenticated', to_regprocedure(sig)::oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'rollback: % is executable by anon or authenticated', sig;
    END IF;
  END LOOP;
END $$;

SELECT public.trigger_makesafe_reconcile('makesafe_email_reconcile');
SELECT public.trigger_makesafe_status_canary();
SELECT public.trigger_makesafe_portal_recheck();
SELECT public.trigger_makesafe_sent_mirror();
SELECT public.trigger_makesafe_story_recompute();
SELECT public.trigger_makesafe_status_shadow_refresh();

BEGIN;
\ir fixture.sql
DO $$
DECLARE
  c record;
BEGIN
  IF (SELECT array_agg(url ORDER BY n) FROM net.calls)
     IS DISTINCT FROM (SELECT array_agg(url ORDER BY n) FROM expected_calls) THEN
    RAISE EXCEPTION 'rollback: the crons posted %', (SELECT array_agg(url ORDER BY n) FROM net.calls);
  END IF;
  FOR c IN SELECT a.url, a.headers, a.body, e.body AS expected_body
             FROM net.calls a JOIN expected_calls e USING (n) LOOP
    IF c.headers IS DISTINCT FROM jsonb_build_object(
         'Content-Type', 'application/json',
         'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets
                                         WHERE name = 'service_role_key')) THEN
      RAISE EXCEPTION 'rollback: % was not restored to the raw Vault read (posted %)', c.url, c.headers;
    END IF;
    IF c.body IS DISTINCT FROM c.expected_body THEN
      RAISE EXCEPTION 'rollback: % posted body %, expected %', c.url, c.body, c.expected_body;
    END IF;
  END LOOP;
END $$;
ROLLBACK;
