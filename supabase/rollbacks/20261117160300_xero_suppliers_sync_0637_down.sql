-- P0-10.1 rollback: restore the supplier sync to 06:55 Perth (22:55 UTC).
DO $cron$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'xero-suppliers-sync: pg_cron absent, schedule unchanged';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM cron.job
    WHERE jobname = 'xero-suppliers-sync' AND schedule = '55 22 * * *'
  ) THEN
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'xero-suppliers-sync') THEN
    RAISE NOTICE 'xero-suppliers-sync: job absent, not scheduled';
    RETURN;
  END IF;

  PERFORM cron.alter_job(jobid, schedule := '55 22 * * *')
  FROM cron.job WHERE jobname = 'xero-suppliers-sync';
END $cron$;
