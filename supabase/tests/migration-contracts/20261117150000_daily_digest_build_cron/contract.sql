-- Contract for 20261117150000_daily_digest_build_cron.
\set ON_ERROR_STOP on

-- 1. The trigger posts build or canary to daily-digest with the stored key (on a pg_net stand-in);
--    anything else is refused and posts nothing.
BEGIN;
CREATE SCHEMA net;
CREATE TABLE net.calls (url text, headers jsonb, body jsonb, timeout_milliseconds integer);
CREATE FUNCTION net.http_post(url text, headers jsonb DEFAULT '{}'::jsonb,
  body jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000) RETURNS bigint
LANGUAGE sql AS $$
  INSERT INTO net.calls VALUES (url, headers, body, timeout_milliseconds);
  SELECT 1::bigint
$$;
DO $$
DECLARE c record; a text; refused boolean;
BEGIN
  FOREACH a IN ARRAY ARRAY['build', 'canary'] LOOP
    DELETE FROM net.calls;
    PERFORM public.trigger_daily_digest_action(a);
    IF (SELECT count(*) FROM net.calls) <> 1 THEN
      RAISE EXCEPTION 'contract: % posted % calls, expected 1', a, (SELECT count(*) FROM net.calls);
    END IF;
    SELECT * INTO c FROM net.calls;
    IF c.url <> 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/daily-digest?action=' || a THEN
      RAISE EXCEPTION 'contract: % posted to %', a, c.url;
    END IF;
    IF c.headers->>'Authorization' IS DISTINCT FROM 'Bearer ' || public.sw_service_key()
       OR c.headers->>'x-sw-actor' IS DISTINCT FROM 'daily-digest-cron'
       OR c.body <> '{}'::jsonb OR c.timeout_milliseconds <> 150000 THEN
      RAISE EXCEPTION 'contract: % is not the scheduled shape (actor %, body %, timeout %)',
        a, c.headers->>'x-sw-actor', c.body, c.timeout_milliseconds;
    END IF;
  END LOOP;
  DELETE FROM net.calls;
  FOREACH a IN ARRAY ARRAY['anything_else', 'latest', '', 'BUILD', 'build&action=canary'] LOOP
    refused := false;
    BEGIN
      PERFORM public.trigger_daily_digest_action(a);
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'daily_digest_action_not_allowed:%' THEN RAISE; END IF;
      refused := true;
    END;
    IF NOT refused THEN RAISE EXCEPTION 'contract: action "%" was not refused', a; END IF;
  END LOOP;
  refused := false;
  BEGIN
    PERFORM public.trigger_daily_digest_action(NULL);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'daily_digest_action_not_allowed:%' THEN RAISE; END IF;
    refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'contract: a null action was not refused'; END IF;
  IF (SELECT count(*) FROM net.calls) <> 0 THEN
    RAISE EXCEPTION 'contract: a refused action still posted';
  END IF;
END $$;
ROLLBACK;

-- 2. Only the service role and the owner may call it; it is security definer with a pinned search
--    path; its source reads the stored key and holds nothing shaped like a token.
DO $$
DECLARE src text;
BEGIN
  IF has_function_privilege('anon', 'public.trigger_daily_digest_action(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.trigger_daily_digest_action(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract: the digest trigger is executable by anon or authenticated';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.trigger_daily_digest_action(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract: the service role cannot call the digest trigger';
  END IF;
  IF NOT (SELECT prosecdef AND proconfig = ARRAY['search_path=public, pg_temp']
            FROM pg_proc WHERE oid = 'public.trigger_daily_digest_action(text)'::regprocedure) THEN
    RAISE EXCEPTION 'contract: the trigger is not security definer with a pinned search path';
  END IF;
  SELECT prosrc INTO src FROM pg_proc WHERE oid = 'public.trigger_daily_digest_action(text)'::regprocedure;
  IF position('sw_service_key()' IN src) = 0 THEN
    RAISE EXCEPTION 'contract: the trigger does not read the stored key';
  END IF;
  IF src ~ '[A-Za-z0-9._-]{40,}' THEN
    RAISE EXCEPTION 'contract: the trigger source holds a token-shaped run: %', substring(src FROM '[A-Za-z0-9._-]{40,}');
  END IF;
  IF obj_description('public.trigger_daily_digest_action(text)'::regprocedure, 'pg_proc') NOT LIKE '20261117150000:%' THEN
    RAISE EXCEPTION 'contract: the trigger comment does not name 20261117150000';
  END IF;
END $$;

-- 3. No daily-digest job: applied twice it schedules exactly one build job at 23:00 UTC and one canary
--    job at Sunday 21:30 UTC, and leaves other jobs untouched. The rollback removes only the canary
--    job; the migration then applies again.
BEGIN;
\ir cron_stand_in.sql
CREATE TEMP TABLE before_jobs ON COMMIT DROP AS SELECT jobid, jobname, schedule, command, active FROM cron.job;
\ir ../../../migrations/20261117150000_daily_digest_build_cron.sql
\ir ../../../migrations/20261117150000_daily_digest_build_cron.sql
DO $$
BEGIN
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'daily-digest') <> 1
     OR (SELECT count(*) FROM cron.job WHERE jobname = 'daily-digest-canary') <> 1 THEN
    RAISE EXCEPTION 'contract: expected one daily-digest and one daily-digest-canary job, found %',
      (SELECT jsonb_agg(row_to_json(j)) FROM cron.job j);
  END IF;
  IF (SELECT schedule || ' | ' || command || ' | ' || active FROM cron.job WHERE jobname = 'daily-digest')
       IS DISTINCT FROM '0 23 * * * | SELECT public.trigger_daily_digest_action(''build'') | true' THEN
    RAISE EXCEPTION 'contract: the build job is wrong: %',
      (SELECT schedule || ' | ' || command FROM cron.job WHERE jobname = 'daily-digest');
  END IF;
  IF (SELECT schedule || ' | ' || command || ' | ' || active FROM cron.job WHERE jobname = 'daily-digest-canary')
       IS DISTINCT FROM '30 21 * * 0 | SELECT public.trigger_daily_digest_action(''canary'') | true' THEN
    RAISE EXCEPTION 'contract: the canary job is wrong: %',
      (SELECT schedule || ' | ' || command FROM cron.job WHERE jobname = 'daily-digest-canary');
  END IF;
  IF EXISTS (SELECT 1 FROM before_jobs b
              WHERE NOT EXISTS (SELECT 1 FROM cron.job j WHERE (j.jobid, j.jobname, j.schedule, j.command, j.active)
                                                             = (b.jobid, b.jobname, b.schedule, b.command, b.active)))
     OR (SELECT count(*) FROM cron.job) <> (SELECT count(*) FROM before_jobs) + 2 THEN
    RAISE EXCEPTION 'contract: a job that was already scheduled changed: %',
      (SELECT jsonb_agg(row_to_json(j)) FROM cron.job j);
  END IF;
END $$;
\ir ../../../rollbacks/20261117150000_daily_digest_build_cron_down.sql
\ir ../../../rollbacks/20261117150000_daily_digest_build_cron_down.sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-digest-canary') THEN
    RAISE EXCEPTION 'contract: the rollback left the canary job';
  END IF;
  IF (SELECT command FROM cron.job WHERE jobname = 'daily-digest')
       IS DISTINCT FROM 'SELECT public.trigger_daily_digest_action(''build'')' THEN
    RAISE EXCEPTION 'contract: the rollback changed the build job';
  END IF;
  IF to_regprocedure('public.trigger_daily_digest_action(text)') IS NULL THEN
    RAISE EXCEPTION 'contract: the rollback removed the trigger the build job calls';
  END IF;
END $$;
\ir ../../../migrations/20261117150000_daily_digest_build_cron.sql
DO $$
BEGIN
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'daily-digest-canary') <> 1
     OR (SELECT count(*) FROM cron.job WHERE jobname = 'daily-digest') <> 1 THEN
    RAISE EXCEPTION 'contract: the migration did not apply again after a rollback';
  END IF;
END $$;
ROLLBACK;

-- 4. An existing daily-digest job, inactive and with an old command that holds a pasted key, keeps its
--    id and is changed in place: new schedule, the stored-key command, active. The old text is gone.
--    An existing daily-digest-canary job is left as it was.
BEGIN;
\ir cron_stand_in.sql
INSERT INTO cron.job (jobname, schedule, command, active) VALUES
  ('daily-digest', '0 22 * * *',
   'SELECT net.http_post(url:=''https://example.invalid/functions/v1/daily-digest'', headers:=''{"Authorization": "Bearer stand-in-old-pasted-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}''::jsonb)',
   false),
  ('daily-digest-canary', '0 5 * * 1', 'SELECT 1');
CREATE TEMP TABLE old_ids ON COMMIT DROP AS SELECT jobname, jobid FROM cron.job;
\ir ../../../migrations/20261117150000_daily_digest_build_cron.sql
DO $$
BEGIN
  IF (SELECT jobid FROM cron.job WHERE jobname = 'daily-digest')
       IS DISTINCT FROM (SELECT jobid FROM old_ids WHERE jobname = 'daily-digest')
     OR (SELECT count(*) FROM cron.job WHERE jobname = 'daily-digest') <> 1 THEN
    RAISE EXCEPTION 'contract: the daily-digest job was not changed in place: %',
      (SELECT jsonb_agg(row_to_json(j)) FROM cron.job j);
  END IF;
  IF (SELECT schedule || ' | ' || command || ' | ' || active FROM cron.job WHERE jobname = 'daily-digest')
       IS DISTINCT FROM '0 23 * * * | SELECT public.trigger_daily_digest_action(''build'') | true' THEN
    RAISE EXCEPTION 'contract: the existing job was not moved to the build: %',
      (SELECT schedule || ' | ' || command || ' | ' || active FROM cron.job WHERE jobname = 'daily-digest');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE command LIKE '%stand-in-old-pasted-key%') THEN
    RAISE EXCEPTION 'contract: the old pasted key is still in a command';
  END IF;
  IF (SELECT schedule || ' | ' || command FROM cron.job WHERE jobname = 'daily-digest-canary')
       IS DISTINCT FROM '0 5 * * 1 | SELECT 1'
     OR (SELECT count(*) FROM cron.job WHERE jobname = 'daily-digest-canary') <> 1 THEN
    RAISE EXCEPTION 'contract: an existing canary job was changed or doubled';
  END IF;
END $$;
ROLLBACK;
