-- 0. In the registered stack there is no pg_cron, so the migration was a
--    no-op; everything below builds its own stand-ins inside one transaction
--    and rolls it back, so no stand-in outlives this file.
DO $$
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    RAISE EXCEPTION 'contract: a cron.job stand-in outlived its transaction';
  END IF;
END $$;

BEGIN;
\ir fixture.sql
SAVEPOINT fixture_built;
SELECT cron_contract.run_http_jobs('before', true);
\ir ../../../migrations/20260930120000_cron_service_key_from_vault.sql

-- 1. No cron command carries a pasted key (JWT-shaped, or the Vault key's own
--    value), and each of the twelve named jobs reads the key through
--    public.sw_service_key() only.
DO $$
DECLARE
  j record;
  v_key text := (SELECT stack_key FROM cron_contract.fixture);
  v_named integer := 0;
BEGIN
  FOR j IN SELECT jobname, command FROM cron.job ORDER BY jobid LOOP
    IF j.command ~ 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'
       OR strpos(j.command, v_key) > 0 THEN
      RAISE EXCEPTION 'contract: cron job % still carries a pasted service key', j.jobname;
    END IF;
  END LOOP;

  FOR j IN
    SELECT jobname, command FROM cron.job
     WHERE jobname IN (
       'xero-token-refresh', 'xero-po-sync', 'xero-reports-sync',
       'xero-projects-sync', 'xero-tracking-pl-sync', 'xero-bank-sync',
       'xero-payables-sync', 'xero-suppliers-sync', 'contact-matching',
       'system-health-check', 'xero-invoice-sync', 'weekly-ceo-financial-brief'
     )
  LOOP
    v_named := v_named + 1;
    IF j.command ~ '_sw_service_key' THEN
      RAISE EXCEPTION 'contract: cron job % still calls the legacy _sw_service_key()', j.jobname;
    END IF;
    IF j.command !~ 'public\.sw_service_key\(\)' THEN
      RAISE EXCEPTION 'contract: cron job % does not read public.sw_service_key()', j.jobname;
    END IF;
  END LOOP;

  IF v_named <> 12 THEN
    RAISE EXCEPTION 'contract: expected 12 named cron jobs, found %', v_named;
  END IF;
END $$;

-- 2. Jobs were altered in place: same ids, schedules, active flags, owners and
--    databases, and the unrelated jobs are byte-identical.
DO $$
DECLARE
  v_diff text;
BEGIN
  SELECT string_agg(coalesce(b.jobname, a.jobname), ', ')
    INTO v_diff
    FROM cron_contract.before b
    FULL JOIN cron.job a USING (jobid)
   WHERE a.jobid IS NULL OR b.jobid IS NULL
      OR (b.jobname, b.schedule, b.active, b.username, b.database)
         IS DISTINCT FROM (a.jobname, a.schedule, a.active, a.username, a.database);
  IF v_diff IS NOT NULL THEN
    RAISE EXCEPTION 'contract: cron job placement changed for %', v_diff;
  END IF;

  SELECT string_agg(a.jobname, ', ')
    INTO v_diff
    FROM cron_contract.before b
    JOIN cron.job a USING (jobid)
   WHERE a.jobname IN ('process-outbound-queue', 'daily-digest-trigger')
     AND a.command IS DISTINCT FROM b.command;
  IF v_diff IS NOT NULL THEN
    RAISE EXCEPTION 'contract: unrelated cron job command changed for %', v_diff;
  END IF;
END $$;

-- 3. Every rewritten job sends exactly what it sent before: same URL, body and
--    headers, with the Vault key as the bearer.
SELECT cron_contract.run_http_jobs('after', false);
DO $$
DECLARE
  v_diff text := cron_contract.wire_diff('before', 'after');
BEGIN
  IF (SELECT count(*) FROM cron_contract.sent WHERE phase = 'after') <> 12 THEN
    RAISE EXCEPTION 'contract: expected 12 http calls after the rewrite';
  END IF;
  IF v_diff IS NOT NULL THEN
    RAISE EXCEPTION 'contract: cron job request changed on the wire for %', v_diff;
  END IF;
  IF EXISTS (
    SELECT 1 FROM cron_contract.sent
     WHERE phase = 'after'
       AND headers->>'Authorization' IS DISTINCT FROM
           'Bearer ' || (SELECT stack_key FROM cron_contract.fixture)
  ) THEN
    RAISE EXCEPTION 'contract: a rewritten cron job does not send the Vault key';
  END IF;
END $$;

-- 4. Re-running the migration changes nothing.
CREATE TABLE cron_contract.migrated AS SELECT jobid, command FROM cron.job;
\ir ../../../migrations/20260930120000_cron_service_key_from_vault.sql
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cron.job a JOIN cron_contract.migrated m USING (jobid)
     WHERE a.command IS DISTINCT FROM m.command
  ) THEN
    RAISE EXCEPTION 'contract: re-running the migration changed a job';
  END IF;
END $$;
SAVEPOINT migrated;

-- 5. The key now follows Vault: a rotated value reaches every job with no
--    further edit.
CREATE OR REPLACE FUNCTION public.sw_service_key() RETURNS text
  LANGUAGE sql AS $$ SELECT 'eyJyb3RhdGVk.Zml4dHVyZQ.Y29udHJhY3Q'::text $$;
SELECT cron_contract.run_http_jobs('rotated', false);
DO $$
BEGIN
  IF (SELECT count(*) FROM cron_contract.sent WHERE phase = 'rotated') <> 12
     OR EXISTS (
       SELECT 1 FROM cron_contract.sent
        WHERE phase = 'rotated'
          AND headers->>'Authorization' IS DISTINCT FROM 'Bearer eyJyb3RhdGVk.Zml4dHVyZQ.Y29udHJhY3Q'
     ) THEN
    RAISE EXCEPTION 'contract: a cron job did not pick up the rotated Vault key';
  END IF;
END $$;
ROLLBACK TO SAVEPOINT migrated;

-- 6. When the Vault read fails, a job fails closed instead of sending.
CREATE OR REPLACE FUNCTION public.sw_service_key() RETURNS text AS $$
BEGIN
  RAISE EXCEPTION 'contract: vault unreadable';
END;
$$ LANGUAGE plpgsql;
DO $$
BEGIN
  PERFORM set_config('cron_contract.phase', 'unreadable', true);
  EXECUTE (SELECT command FROM cron.job WHERE jobname = 'xero-invoice-sync');
  RAISE EXCEPTION 'contract: xero-invoice-sync ran without a readable Vault key';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'contract: vault unreadable' THEN
    RAISE;
  END IF;
END $$;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron_contract.sent WHERE phase = 'unreadable') THEN
    RAISE EXCEPTION 'contract: xero-invoice-sync posted without a Vault key';
  END IF;
END $$;
ROLLBACK TO SAVEPOINT migrated;

-- 7. The production shape: with a JWT-shaped Vault key pasted into the same
--    jobs, the migration rewrites every one and the wire is unchanged.
ROLLBACK TO SAVEPOINT fixture_built;
CREATE OR REPLACE FUNCTION public.sw_service_key() RETURNS text
  LANGUAGE sql AS $$ SELECT 'eyJmaXh0dXJl.bm90LWEta2V5.Y29udHJhY3Q'::text $$;
UPDATE cron.job a
   SET command = replace(b.command, f.stack_key, 'eyJmaXh0dXJl.bm90LWEta2V5.Y29udHJhY3Q')
  FROM cron_contract.before b, cron_contract.fixture f
 WHERE b.jobid = a.jobid;
SELECT cron_contract.run_http_jobs('jwt_before', false);
\ir ../../../migrations/20260930120000_cron_service_key_from_vault.sql
SELECT cron_contract.run_http_jobs('jwt_after', false);
DO $$
DECLARE
  v_diff text := cron_contract.wire_diff('jwt_before', 'jwt_after');
BEGIN
  IF EXISTS (
    SELECT 1 FROM cron.job
     WHERE command ~ 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'
  ) THEN
    RAISE EXCEPTION 'contract: a JWT-shaped key survived the rewrite';
  END IF;
  IF (SELECT count(*) FROM cron_contract.sent WHERE phase = 'jwt_after') <> 12
     OR (SELECT count(*) FROM cron_contract.sent WHERE phase = 'jwt_before') <> 12 THEN
    RAISE EXCEPTION 'contract: expected 12 http calls around the JWT rewrite';
  END IF;
  IF v_diff IS NOT NULL THEN
    RAISE EXCEPTION 'contract: JWT-shaped job request changed on the wire for %', v_diff;
  END IF;
END $$;
ROLLBACK;
