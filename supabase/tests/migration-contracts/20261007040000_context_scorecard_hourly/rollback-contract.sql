-- After the hourly rollback: its four objects are gone; the scorecard it ran
-- and the alert table it reported into are untouched.
DO $$
DECLARE f text;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_scorecard_run_policy()', 'public.context_scorecard_record_run(text)',
   'public.context_scorecard_run_status(timestamptz)'] LOOP
  IF to_regprocedure(f) IS NOT NULL THEN RAISE EXCEPTION 'hourly rollback: % left behind', f; END IF;
 END LOOP;
 IF to_regclass('public.context_scorecard_runs') IS NOT NULL THEN
  RAISE EXCEPTION 'hourly rollback: the run log left behind';
 END IF;
 IF to_regclass('public.ai_alerts') IS NULL THEN
  RAISE EXCEPTION 'hourly rollback: ai_alerts lost';
 END IF;
 IF public.context_scorecard(now())->>'version' IS NULL THEN
  RAISE EXCEPTION 'hourly rollback: the scorecard no longer answers';
 END IF;
END $$;
