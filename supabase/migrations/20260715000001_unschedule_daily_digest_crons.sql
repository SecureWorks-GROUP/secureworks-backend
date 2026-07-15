-- ============================================================
-- Turn daily-digest OFF (unschedule its cron jobs)
-- ============================================================
-- daily-digest is being retired. This stops it firing on its own: the
-- morning brief, intraday nudges, stale/EOD follow-ups and the scheduled
-- CEO brief all stop running.
--
-- Nothing is deleted. The daily-digest function stays deployed and still
-- serves on-demand calls, trigger_daily_digest() still exists, and the
-- daily_digests, ai_alerts and weekly_reports tables are untouched. The
-- subsystem is simply no longer fired by cron, so this is reversible by
-- re-running the original cron.schedule() statements from migrations
-- 20250301000005, 20260318000001, 20260322000003, 20260322000004,
-- 20260322000012 and 20260404000002.
--
-- Forward-only: historical migrations are left untouched.
--
-- The 6 jobs below are the full set that invoke the daily-digest URL:
--   daily-digest         '0 23 * * *'      (morning brief)
--   intraday-nudge-check '0 3,7,11 * * *'  (?action=nudge_check)
--   stale-followup       '0 1 * * *'       (?action=stale_followup)
--   eod-followup-5pm     '0 9 * * 1-5'     (?action=eod_followup)
--   eod-escalation-7pm   '0 11 * * 1-5'    (?action=eod_followup)
--   shaun-morning-brief  '30 23 * * *'     (?action=shaun_brief)
--
-- cron.unschedule() raises if the job is absent, so each call is guarded on
-- the job existing, which makes this migration idempotent.
--
-- That guard alone would hide a real failure: the guarded PERFORM is also a
-- no-op when the job exists but is not visible to the current role, because
-- pg_cron applies RLS on cron.job restricting rows to current_user. That
-- case would otherwise look identical to success while all six crons kept
-- firing. So report each job's actual outcome via GET DIAGNOSTICS +
-- RAISE NOTICE — check the migration log to confirm which were unscheduled.
DO $$
DECLARE
  job_name    text;
  rows_hit    integer;
  unscheduled integer := 0;
BEGIN
  FOREACH job_name IN ARRAY ARRAY[
    'daily-digest',
    'intraday-nudge-check',
    'stale-followup',
    'eod-followup-5pm',
    'eod-escalation-7pm',
    'shaun-morning-brief'
  ] LOOP
    PERFORM cron.unschedule(job_name) FROM cron.job WHERE jobname = job_name;
    GET DIAGNOSTICS rows_hit = ROW_COUNT;

    IF rows_hit > 0 THEN
      unscheduled := unscheduled + 1;
      RAISE NOTICE 'daily-digest off: unscheduled cron job "%"', job_name;
    ELSE
      RAISE NOTICE 'daily-digest off: cron job "%" not unscheduled — either already absent (expected on re-run) or not visible to current_user % under pg_cron RLS; verify with: SELECT jobname FROM cron.job WHERE command LIKE ''%%functions/v1/daily-digest%%'';', job_name, current_user;
    END IF;
  END LOOP;

  RAISE NOTICE 'daily-digest off: % of 6 cron jobs unscheduled', unscheduled;
END $$;
