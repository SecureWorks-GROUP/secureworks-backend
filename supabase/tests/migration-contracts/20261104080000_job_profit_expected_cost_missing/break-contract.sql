-- Remove the promise: the function names nothing, so a job with no expected cost reads a bare blank again.
CREATE OR REPLACE FUNCTION public.job_profit_expected_cost_missing(p_job_id uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $fn$ SELECT NULL::jsonb $fn$;
