-- The runner has just run the down migration against the registered stack,
-- which has no pg_cron, so it must have been a no-op. The rollback's real
-- behaviour is proved below against the production job shapes, inside one
-- rolled-back transaction: the eleven inline jobs carry the Vault key as a
-- literal again, the weekly brief calls the legacy alias, placement is
-- unchanged, every job sends what it sent before the migration, and
-- re-applying the migration takes the key back out.
DO $$
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: a cron.job stand-in outlived its transaction';
  END IF;
END $$;

BEGIN;
\ir fixture.sql
SELECT cron_contract.run_http_jobs('before', true);
\ir ../../../migrations/20260930120000_cron_service_key_from_vault.sql
CREATE TABLE cron_contract.migrated AS SELECT jobid, command FROM cron.job;
\ir ../../../rollbacks/20260930120000_cron_service_key_from_vault_down.sql

DO $$
DECLARE
  v_key text := (SELECT stack_key FROM cron_contract.fixture);
  v_diff text;
BEGIN
  SELECT string_agg(jobname, ', ')
    INTO v_diff
    FROM cron.job
   WHERE jobname IN (
     'xero-token-refresh', 'xero-po-sync', 'xero-reports-sync',
     'xero-projects-sync', 'xero-tracking-pl-sync', 'xero-bank-sync',
     'xero-payables-sync', 'xero-suppliers-sync', 'contact-matching',
     'system-health-check', 'xero-invoice-sync'
   )
     AND (strpos(command, v_key) = 0 OR command ~ 'sw_service_key');
  IF v_diff IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: inline jobs not restored: %', v_diff;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'weekly-ceo-financial-brief'
       AND command ~ 'public\._sw_service_key\(\)'
  ) THEN
    RAISE EXCEPTION 'rollback contract: weekly-ceo-financial-brief does not call the legacy alias';
  END IF;

  SELECT string_agg(coalesce(b.jobname, a.jobname), ', ')
    INTO v_diff
    FROM cron_contract.before b
    FULL JOIN cron.job a USING (jobid)
   WHERE a.jobid IS NULL OR b.jobid IS NULL
      OR (b.jobname, b.schedule, b.active, b.username, b.database)
         IS DISTINCT FROM (a.jobname, a.schedule, a.active, a.username, a.database);
  IF v_diff IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: placement changed for %', v_diff;
  END IF;
END $$;

SELECT cron_contract.run_http_jobs('rolled_back', false);
DO $$
DECLARE
  v_diff text := cron_contract.wire_diff('before', 'rolled_back');
BEGIN
  IF (SELECT count(*) FROM cron_contract.sent WHERE phase = 'rolled_back') <> 12 THEN
    RAISE EXCEPTION 'rollback contract: expected 12 http calls after the rollback';
  END IF;
  IF v_diff IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: request changed on the wire for %', v_diff;
  END IF;
END $$;

\ir ../../../migrations/20260930120000_cron_service_key_from_vault.sql
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cron.job a JOIN cron_contract.migrated m USING (jobid)
     WHERE a.command IS DISTINCT FROM m.command
  ) THEN
    RAISE EXCEPTION 'rollback contract: re-applying the migration after the rollback did not reproduce the migrated jobs';
  END IF;
END $$;
ROLLBACK;
