-- Automated money messages are off (captain, 30 Sep 2026; debt book
-- DECISIONS.md Q6: "all off"). Xero's own reminder emails stay on.
--
-- This migration is the cron half of that switch-off. It unschedules
-- process-payment-events, the 5-minute pg_cron job that calls
-- fn_process_payment_events() (20260406000001_debt_automation.sql), which posts
-- every new invoice.paid business event to ops-api handle_payment_event. That
-- path texted "we've received your payment" to the client, including on a void
-- or credit note (the trigger fires on any amount_due -> 0), and it marked each
-- event processed whatever the HTTP result.
--
-- The code half ships in the same change: handle_payment_event itself no longer
-- sends the text (ops-api/debt_autotexts_off.ts names every path switched off).
-- Nothing else is unscheduled. In particular stale-followup keeps running,
-- because it also sends the stale-quote and house-plans follow-ups the ruling
-- did not cover; its day-3 deposit reminder is removed in daily-digest code.
--
-- What is matched: the job named process-payment-events, and any other job
-- whose command calls fn_process_payment_events or posts to
-- handle_payment_event, so a copy scheduled under another name cannot keep the
-- path alive. Each is unscheduled by id, and its name and id are printed in a
-- NOTICE for the deploy readback (never its command).
--
-- Fail-closed: one DO block, so any refusal unschedules nothing, and the block
-- ends by proving no matching job is left.
--
-- The business_events invoice.paid rows keep accumulating unprocessed. That is
-- intended: the debt desk reads Xero, not these rows, and no sender is left
-- for them to reach.
--
-- Verify after (read-only):
--   SELECT jobid, jobname, schedule, active FROM cron.job
--    WHERE jobname = 'process-payment-events'
--       OR command ILIKE '%fn_process_payment_events%'
--       OR command ILIKE '%handle_payment_event%';
--   -- expect zero rows
-- Rollback: supabase/rollbacks/20260930170000_debt_autotexts_off_down.sql.

DO $$
DECLARE
  v_is_superuser boolean;
  j record;
  v_unscheduled integer := 0;
  v_leftover text;
BEGIN
  -- A database without pg_cron (a fresh migration-provisioned one) has no job
  -- to unschedule.
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'pg_cron is absent; no cron job to unschedule';
    RETURN;
  END IF;

  SELECT rolsuper INTO v_is_superuser FROM pg_roles WHERE rolname = current_user;

  FOR j IN
    SELECT jobid, jobname, username
      FROM cron.job
     WHERE jobname = 'process-payment-events'
        OR command ILIKE '%fn_process_payment_events%'
        OR command ILIKE '%handle_payment_event%'
     ORDER BY jobid
  LOOP
    -- pg_cron only lets a job's owner (or a superuser) unschedule it; say so
    -- plainly instead of surfacing pg_cron's "could not find valid entry".
    IF j.username IS DISTINCT FROM current_user AND NOT coalesce(v_is_superuser, false) THEN
      RAISE EXCEPTION 'cron job % (id %) is owned by %, not %; cannot unschedule it',
        j.jobname, j.jobid, j.username, current_user;
    END IF;

    PERFORM cron.unschedule(j.jobid);
    v_unscheduled := v_unscheduled + 1;
    RAISE NOTICE 'unscheduled cron job % (id %)', j.jobname, j.jobid;
  END LOOP;

  IF v_unscheduled = 0 THEN
    RAISE NOTICE 'no process-payment-events cron job found; nothing to unschedule';
  END IF;

  SELECT string_agg(format('%s (id %s)', jobname, jobid), ', ' ORDER BY jobid)
    INTO v_leftover
    FROM cron.job
   WHERE jobname = 'process-payment-events'
      OR command ILIKE '%fn_process_payment_events%'
      OR command ILIKE '%handle_payment_event%';
  IF v_leftover IS NOT NULL THEN
    RAISE EXCEPTION 'payment thank-you cron jobs are still scheduled: %', v_leftover;
  END IF;
END $$;
