-- Intraday nudge checks: 11am, 3pm, 7pm AWST (UTC+8 = 3am, 7am, 11am UTC)
SELECT cron.schedule(
  'intraday-nudge-check',
  '0 3,7,11 * * *',
  $$ SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/daily-digest?action=nudge_check',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.settings.service_role_key') || '"}'::jsonb,
    body := '{}'::jsonb
  ); $$
);
