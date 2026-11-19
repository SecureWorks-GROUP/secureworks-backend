-- After the down migration the trip audit is gone and the earlier page-trace
-- table is still there. No switch is turned on by the down file.
DO $rb$
BEGIN
  IF to_regclass('public.cost_watchdog_trips') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: trip table still exists';
  END IF;
  IF to_regprocedure('public.director_cost_watchdog_tick(text)') IS NOT NULL
     OR to_regprocedure('public.cost_watchdog_switches()') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: watchdog function still exists';
  END IF;
  IF to_regclass('public.job_watchdog_trips') IS NULL THEN
    RAISE EXCEPTION 'rollback contract: page trace table was dropped';
  END IF;
END
$rb$;
