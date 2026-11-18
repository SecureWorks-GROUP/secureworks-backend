-- Follow-up 58 guard break: job_cost_bill_line_job_id's body is not the one the guard pins,
-- so the contract must refuse (the migration itself does not; _fast falls back instead).
CREATE OR REPLACE FUNCTION public.job_cost_bill_line_job_id(p_text text)
RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS $fn$
  SELECT NULL::uuid -- break: a body the guard was not written against
$fn$;
