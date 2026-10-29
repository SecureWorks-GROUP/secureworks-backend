-- H7 timing (INT-10): how long the job card's bill read takes for one job.
--
-- READ ONLY. Runs exactly what ops-api job_overview calls for one job,
-- public.context_job_bill_outcomes(job), as the service role, under EXPLAIN
-- (ANALYZE, BUFFERS). The job is the newest one Job Profit reads (legacy IS NOT
-- TRUE) that is not a holding job (metadata.do_not_schedule 'true' or '1', any
-- case, as the acceptance script reads it) and has a placed
-- bill: a Xero ACCPAY bill linked to it, or an actual allocation row
-- (job_materials_facts, kind actual) of a bill on it. A job with no bills takes
-- the cheap path and would understate the read. The job is chosen first, in its
-- own statement (kept in the transaction setting h7.job, which
-- current_setting('h7.job') shows), so the timed plan is the read alone. To time
-- another job, put its id in that set_config call. With no such job the read
-- stops on the uuid cast of 'no job with a placed bill'.
-- The function reads only that job's bills through
-- cfo_bill_cost_outcomes_scoped(job) and runs with jit = off; the plan's
-- execution time is the read's time (planning included, since the function
-- plans its body on each call): compare it with the 8 s API statement limit.
-- Writes nothing; the transaction is read only and ends when the session does.
-- The EXPLAIN is the final result set.
BEGIN;
SET TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL ROLE service_role;
SELECT set_config('h7.job', COALESCE((
  SELECT j.id::text FROM public.jobs j
   WHERE j.legacy IS NOT TRUE
     AND lower(COALESCE(j.metadata ->> 'do_not_schedule', '')) NOT IN ('true', '1')
     AND (EXISTS (SELECT 1 FROM public.xero_invoices x
                   WHERE x.job_id = j.id AND x.invoice_type = 'ACCPAY')
          OR EXISTS (SELECT 1 FROM public.job_materials_facts f
                      WHERE f.job_id = j.id AND f.kind = 'actual'
                        AND f.xero_invoice_id IS NOT NULL))
   ORDER BY j.created_at DESC NULLS LAST, j.id DESC
   LIMIT 1
), 'no job with a placed bill'), true);
EXPLAIN (ANALYZE, BUFFERS)
SELECT public.context_job_bill_outcomes(current_setting('h7.job')::uuid);
