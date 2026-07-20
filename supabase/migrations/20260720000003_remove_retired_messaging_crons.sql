-- Stop schedules whose handlers were removed with the retired messaging integration.
SELECT cron.unschedule(jobname)
FROM cron.job
WHERE jobname IN (
  'intraday-nudge-check',
  'eod-followup-5pm',
  'eod-escalation-7pm',
  'shaun-morning-brief'
);
