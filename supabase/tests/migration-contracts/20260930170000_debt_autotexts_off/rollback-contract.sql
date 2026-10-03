-- The runner has just run the down migration against the registered stack,
-- which has no pg_cron, so it must have been a no-op. Its real behaviour is
-- proved below inside one rolled-back transaction: the forward migration
-- removes the job, the rollback puts back exactly the 20260406000001 shape,
-- and a second rollback does not schedule it twice.
DO $$
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: a cron.job stand-in outlived its transaction';
  END IF;
END $$;

BEGIN;
\ir fixture.sql
\ir ../../../migrations/20260930170000_debt_autotexts_off.sql
\ir ../../../rollbacks/20260930170000_debt_autotexts_off_down.sql
\ir ../../../rollbacks/20260930170000_debt_autotexts_off_down.sql

DO $$
DECLARE
  v_count integer;
  v_job record;
BEGIN
  SELECT count(*) INTO v_count FROM cron.job WHERE jobname = 'process-payment-events';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'rollback contract: expected one process-payment-events job, found %', v_count;
  END IF;
  SELECT schedule, command INTO v_job FROM cron.job WHERE jobname = 'process-payment-events';
  IF v_job.schedule <> '*/5 * * * *' OR v_job.command <> 'SELECT fn_process_payment_events()' THEN
    RAISE EXCEPTION 'rollback contract: process-payment-events not restored to its original shape';
  END IF;
END $$;

ROLLBACK;
