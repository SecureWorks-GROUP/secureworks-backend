-- After the hourly rollback: its four functions and two tables are gone; the
-- scorecard it ran is untouched and still answers.
DO $$
DECLARE f text;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_scorecard_run_policy()', 'public.context_scorecard_record_run(text)',
   'public.context_scorecard_record_receipt(text,bigint,integer[])', 'public.context_scorecard_run_status(timestamptz)'] LOOP
  IF to_regprocedure(f) IS NOT NULL THEN RAISE EXCEPTION 'hourly rollback: % left behind', f; END IF;
 END LOOP;
 IF to_regclass('public.context_scorecard_runs') IS NOT NULL OR to_regclass('public.context_scorecard_receipts') IS NOT NULL THEN
  RAISE EXCEPTION 'hourly rollback: the run log or the receipts left behind';
 END IF;
 IF public.context_scorecard(now())->>'version' IS NULL THEN
  RAISE EXCEPTION 'hourly rollback: the scorecard no longer answers';
 END IF;
END $$;
