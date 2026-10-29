-- H7 timing (INT-10): how long the job card's bill read takes for one job.
--
-- READ ONLY. Runs exactly what ops-api job_overview calls for one job,
-- public.context_job_bill_outcomes(job), as the service role, for the newest
-- job Job Profit reads (legacy IS NOT TRUE), under EXPLAIN (ANALYZE, BUFFERS).
-- The function reads only that job's bills through
-- cfo_bill_cost_outcomes_scoped(job) and runs with jit = off; the plan's
-- execution time is the read's time (planning included, since the function
-- plans its body on each call): compare it with the 8 s API statement limit.
-- For a job with bills, swap the subquery for that job's id. Writes nothing; the transaction is read only and
-- ends when the session does. The EXPLAIN is the final result set.
BEGIN;
SET TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL ROLE service_role;
EXPLAIN (ANALYZE, BUFFERS)
SELECT public.context_job_bill_outcomes((
  SELECT j.id FROM public.jobs j
   WHERE j.legacy IS NOT TRUE
   ORDER BY j.created_at DESC NULLS LAST, j.id DESC
   LIMIT 1
));
