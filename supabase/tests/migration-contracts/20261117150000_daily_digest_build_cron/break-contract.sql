-- Deliberately take the action guard out of the trigger: the contract must fail.
CREATE OR REPLACE FUNCTION public.trigger_daily_digest_action(p_action text)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  RETURN net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/daily-digest?action=' || coalesce(p_action, ''),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || public.sw_service_key(),
      'Content-Type', 'application/json',
      'x-sw-actor', 'daily-digest-cron'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
END $fn$;
