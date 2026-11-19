-- After the rollback: both functions are gone; the marker table and the switch
-- are as they were, and Job Profit's reader still answers.
DO $$
BEGIN
  IF to_regprocedure('public.job_cost_events_cutover_check(uuid,date)') IS NOT NULL
     OR to_regprocedure('public.job_cost_events_cutover_complete(uuid,date,boolean)') IS NOT NULL THEN
    RAISE EXCEPTION 'F2 cutover rollback: a function is still there'; END IF;
  IF to_regclass('public.job_cost_events_cutover') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.job_cost_events_cutover WHERE singleton) THEN
    RAISE EXCEPTION 'F2 cutover rollback: the marker row went with the functions'; END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'job_cost_events_from_cost_lines_v1' AND enabled) THEN
    RAISE EXCEPTION 'F2 cutover rollback: the switch is on'; END IF;
END;
$$;
SELECT count(*) FROM public.v_job_cost_events;
SELECT 'PASS F2 cutover rollback: functions dropped, marker and switch kept';
