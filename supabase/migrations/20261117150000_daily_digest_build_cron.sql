-- P0-14.2: the daily digest timer calls the build by name with the stored server key.
--
-- One timer, at 23:00 UTC (07:00 Perth), asks the daily-digest function to build
-- (action=build), signing in with public.sw_service_key(). A second, weekly timer
-- runs the ten test chats (action=canary) at 21:30 UTC on Sunday (05:30 Perth on
-- Monday, before the Monday build). No key is written here.
--
-- A job named daily-digest is changed in place (cron.alter_job): an older record of
-- that job (20260404000002) carried a pasted key in its command, which is not copied
-- and not put back. Without a daily-digest job one is scheduled. A daily-digest-canary
-- job that already exists is left as it is. No other job is touched.
--
-- Safe before the matching function: until the function knows action=build, a
-- server POST is its normal full run.

CREATE OR REPLACE FUNCTION public.trigger_daily_digest_action(p_action text)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('build', 'canary') THEN
    RAISE EXCEPTION 'daily_digest_action_not_allowed: %', p_action;
  END IF;
  RETURN net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/daily-digest?action=' || p_action,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || public.sw_service_key(),
      'Content-Type', 'application/json',
      'x-sw-actor', 'daily-digest-cron'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
END $fn$;
COMMENT ON FUNCTION public.trigger_daily_digest_action(text) IS
  '20261117150000: posts daily-digest?action=build (pg_cron daily-digest, 23:00 UTC) or action=canary (pg_cron daily-digest-canary, Sunday 21:30 UTC) with the stored service key. Any other action is refused.';
REVOKE ALL ON FUNCTION public.trigger_daily_digest_action(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_daily_digest_action(text) TO service_role, postgres;

DO $cron$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'daily digest: pg_cron absent, timers not scheduled';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-digest') THEN
    PERFORM cron.alter_job(job_id := jobid, schedule := '0 23 * * *',
      command := $c$SELECT public.trigger_daily_digest_action('build')$c$, active := true)
      FROM cron.job WHERE jobname = 'daily-digest';
  ELSE
    PERFORM cron.schedule('daily-digest', '0 23 * * *',
      $c$SELECT public.trigger_daily_digest_action('build')$c$);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-digest-canary') THEN
    PERFORM cron.schedule('daily-digest-canary', '30 21 * * 0',
      $c$SELECT public.trigger_daily_digest_action('canary')$c$);
  END IF;
END $cron$;
