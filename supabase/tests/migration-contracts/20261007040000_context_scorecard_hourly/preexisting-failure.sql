-- Another lane already wrote a run-status read by hand, a receipts table of
-- another shape, and a pg_cron job of this name that runs something else. The
-- guard must refuse and name all three, not replace them.
CREATE FUNCTION public.context_scorecard_run_status(p_as_of timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
COMMENT ON FUNCTION public.context_scorecard_run_status(timestamptz) IS 'hand-made status';
CREATE TABLE public.context_scorecard_receipts (id bigint PRIMARY KEY, note text);
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, schedule text NOT NULL, command text NOT NULL,
 active boolean NOT NULL DEFAULT true, jobname text);
INSERT INTO cron.job (jobname, schedule, command) VALUES ('context-scorecard-hourly', '*/5 * * * *', 'SELECT 1');
