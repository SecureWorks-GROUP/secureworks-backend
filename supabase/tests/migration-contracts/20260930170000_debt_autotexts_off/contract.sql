-- 0. In the registered stack there is no pg_cron, so the migration was a
--    no-op; everything below builds its own stand-in inside one transaction
--    and rolls it back, so no stand-in outlives this file.
DO $$
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    RAISE EXCEPTION 'contract: a cron.job stand-in outlived its transaction';
  END IF;
END $$;

BEGIN;
\ir fixture.sql
\ir ../../../migrations/20260930170000_debt_autotexts_off.sql

-- 1. No job that can reach handle_payment_event is left: the named job, the
--    copy under another name and the direct post are all gone.
DO $$
DECLARE
  v_left text;
BEGIN
  SELECT string_agg(jobname, ', ' ORDER BY jobid) INTO v_left
    FROM cron.job
   WHERE jobname IN ('process-payment-events', 'payment-events-copy', 'payment-event-direct')
      OR command ILIKE '%fn_process_payment_events%'
      OR command ILIKE '%handle_payment_event%';
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'contract: payment thank-you jobs still scheduled: %', v_left;
  END IF;
END $$;

-- 2. Every other job is byte-identical: same id, name, schedule, command,
--    owner and active flag. stale-followup keeps running.
DO $$
DECLARE
  v_diff text;
BEGIN
  SELECT string_agg(coalesce(u.jobname, j.jobname), ', ') INTO v_diff
    FROM cron_contract.untouched u
    FULL JOIN cron.job j ON j.jobid = u.jobid
   WHERE u.jobid IS NULL OR j.jobid IS NULL
      OR (u.jobname, u.schedule, u.command, u.username, u.active)
         IS DISTINCT FROM (j.jobname, j.schedule, j.command, j.username, j.active);
  IF v_diff IS NOT NULL THEN
    RAISE EXCEPTION 'contract: jobs outside the ruling changed: %', v_diff;
  END IF;
END $$;

-- 3. Re-applying is a no-op.
\ir ../../../migrations/20260930170000_debt_autotexts_off.sql
DO $$
BEGIN
  IF (SELECT count(*) FROM cron.job) <> 3 THEN
    RAISE EXCEPTION 'contract: re-apply changed the job set';
  END IF;
END $$;

ROLLBACK;

DO $$
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    RAISE EXCEPTION 'contract: the cron.job stand-in outlived its transaction';
  END IF;
END $$;
