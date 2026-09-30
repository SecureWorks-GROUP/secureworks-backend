-- Rollback for 20260930170000_debt_autotexts_off.sql.
--
-- Re-schedules process-payment-events exactly as
-- 20260406000001_debt_automation.sql created it: every 5 minutes,
-- SELECT fn_process_payment_events(). Only when no such job exists, so a re-run
-- never schedules it twice.
--
-- This restores the cron only. The ops-api code that shipped with the
-- migration no longer sends the thank-you text, so rolling back the cron alone
-- brings back the invoice.paid bookkeeping (follow-ups resolved, a "Payment
-- received" chase-log row), not a message to the client. Automated money
-- messages stay off until the captain rules otherwise.

DO $$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'pg_cron is absent; nothing to re-schedule';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-payment-events') THEN
    RAISE NOTICE 'process-payment-events is already scheduled; left unchanged';
    RETURN;
  END IF;

  PERFORM cron.schedule(
    'process-payment-events',
    '*/5 * * * *',
    'SELECT fn_process_payment_events()'
  );
  RAISE NOTICE 're-scheduled process-payment-events';
END $$;
