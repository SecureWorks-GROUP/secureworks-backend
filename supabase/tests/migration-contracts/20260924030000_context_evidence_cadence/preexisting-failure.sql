-- A replaced function has drifted from production's pre-image (a hand-applied
-- change nobody read), the one-run-a-day index has been redefined, and a K1
-- name is already taken by another body. The guard must stop before
-- replacing anything and name each one.
CREATE OR REPLACE FUNCTION public.claim_context_pass(p_run_date date) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT '{"outcome":"paused","drift":true}'::jsonb $$;
DROP INDEX public.context_extraction_runs_job_day_phase;
CREATE UNIQUE INDEX context_extraction_runs_job_day_phase ON public.context_extraction_runs(job_id,run_date);
CREATE FUNCTION public.context_job_cadence(p_job_id uuid) RETURNS jsonb LANGUAGE sql SET search_path=pg_catalog AS $$ SELECT '{}'::jsonb $$;
