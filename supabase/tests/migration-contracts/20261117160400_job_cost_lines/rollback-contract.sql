DO $$
BEGIN
  IF to_regclass('public.job_cost_lines') IS NOT NULL
     OR to_regclass('public.job_cost_line_parts') IS NOT NULL
     OR to_regprocedure('public.job_cost_lines_parts_check()') IS NOT NULL THEN
    RAISE EXCEPTION 'cost lines rollback contract: foundation remains';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags
      WHERE flag_name IN ('job_cost_lines_sync_v1', 'job_cost_events_from_cost_lines_v1')) THEN
    RAISE EXCEPTION 'cost lines rollback contract: switch remains';
  END IF;
  IF to_regclass('public.jobs') IS NULL THEN
    RAISE EXCEPTION 'cost lines rollback contract: jobs removed';
  END IF;
END;
$$;
\ir ../../../rollbacks/20261117160400_job_cost_lines_down.sql

BEGIN;
\ir ../../../migrations/20261117160400_job_cost_lines.sql
DO $$
BEGIN
  IF to_regclass('public.job_cost_lines') IS NULL OR to_regclass('public.job_cost_line_parts') IS NULL THEN
    RAISE EXCEPTION 'cost lines rollback contract: forward reapply failed';
  END IF;
END;
$$;
ROLLBACK;
