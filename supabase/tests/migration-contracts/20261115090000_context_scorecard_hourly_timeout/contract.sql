-- Contract for 20261115090000_context_scorecard_hourly_timeout: the hourly run's statement
-- timeout is 110 s, the job's command is built from it, nothing else of the policy moved, and
-- a job on the old command is moved to the new one.
DO $policy$
DECLARE pol jsonb := public.context_scorecard_run_policy();
BEGIN
 IF pol->>'statement_timeout' IS DISTINCT FROM '110s' THEN
  RAISE EXCEPTION 'hourly timeout contract: statement_timeout is %, not 110s', pol->>'statement_timeout';
 END IF;
 IF pol->>'command' IS DISTINCT FROM
    'SET statement_timeout = ''110s''; SET lock_timeout = ''10s''; SELECT public.context_scorecard_record_run(''cron'')' THEN
  RAISE EXCEPTION 'hourly timeout contract: command wrong: %', pol->>'command';
 END IF;
 -- Under the server's 120 s, and a slow run still reads slow.
 IF extract(epoch FROM (pol->>'statement_timeout')::interval) > 110
    OR (pol->>'slow_after_ms')::integer <> 30000 THEN
  RAISE EXCEPTION 'hourly timeout contract: limits out of range: %', pol;
 END IF;
 IF pol - 'statement_timeout' - 'command' IS DISTINCT FROM jsonb_build_object(
     'version', 'context-scorecard-hourly-v1', 'cron_job', 'context-scorecard-hourly', 'schedule', '40 * * * *',
     'lock_timeout', '10s', 'late_after_minutes', 75, 'window_hours', 24,
     'missed_hours', jsonb_build_object('green', 0, 'amber', 1), 'slow_after_ms', 30000, 'keep_days', 180,
     'report', jsonb_build_object('surface', 'context_scorecard_run_status', 'readers', jsonb_build_array('rayleigh'),
      'receipt_fresh_minutes', 75)) THEN
  RAISE EXCEPTION 'hourly timeout contract: another number of the policy moved: %', pol;
 END IF;
 IF coalesce(obj_description('public.context_scorecard_run_policy()'::regprocedure, 'pg_proc'), '')
    NOT LIKE 'Context scorecard hourly (20261007040000)%' THEN
  RAISE EXCEPTION 'hourly timeout contract: the policy comment lost the hourly slice name';
 END IF;
 IF has_function_privilege('anon', 'public.context_scorecard_run_policy()', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.context_scorecard_run_policy()', 'EXECUTE') THEN
  RAISE EXCEPTION 'hourly timeout contract: the policy is open to a browser role';
 END IF;
END $policy$;
