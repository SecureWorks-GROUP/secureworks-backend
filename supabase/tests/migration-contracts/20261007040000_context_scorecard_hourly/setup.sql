-- Prerequisites for 20261007040000_context_scorecard_hourly: the scorecard it
-- runs comes from an earlier registered case (20261006032000). Nothing else is
-- read or written outside the migration's own tables, so nothing else is set up
-- (no ai_alerts stand-in: the hourly run never writes an alert).
DO $$
BEGIN
 IF to_regprocedure('public.context_scorecard(timestamptz)') IS NULL THEN
  RAISE EXCEPTION 'hourly setup: public.context_scorecard(timestamptz) is missing from the registered stack';
 END IF;
END $$;
