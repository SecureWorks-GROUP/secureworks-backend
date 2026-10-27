-- Rollback for 20261020093000_job_review_opt_out.sql.
--
-- Drops the per-job review switch. Every job then reads as not opted out again, so a job
-- someone switched off would be texted by the automatic sender once it is live: roll the
-- matching ops-api back first (it selects these columns). The review_opt_out_changed
-- job_events rows stay as history. Re-running it is a no-op.

ALTER TABLE public.jobs DROP COLUMN IF EXISTS review_opt_out_by;
ALTER TABLE public.jobs DROP COLUMN IF EXISTS review_opt_out_at;
ALTER TABLE public.jobs DROP COLUMN IF EXISTS review_opt_out;
