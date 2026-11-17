-- P2-01.1: remove only the empty foundation. Keep recorded cost evidence.
DO $$
DECLARE
  has_lines boolean := false;
BEGIN
  IF to_regclass('public.job_cost_lines') IS NOT NULL THEN
    LOCK TABLE public.job_cost_lines IN ACCESS EXCLUSIVE MODE;
    SELECT EXISTS (SELECT 1 FROM public.job_cost_lines) INTO has_lines;
  END IF;
  IF has_lines THEN
    RAISE EXCEPTION 'job_cost_lines_rollback_has_data';
  END IF;
  DROP TABLE IF EXISTS public.job_cost_line_parts;
  DROP TABLE IF EXISTS public.job_cost_lines;
  DROP FUNCTION IF EXISTS public.job_cost_lines_parts_check();
  DELETE FROM public.feature_flags
    WHERE flag_name IN ('job_cost_lines_sync_v1', 'job_cost_events_from_cost_lines_v1');
END;
$$;
