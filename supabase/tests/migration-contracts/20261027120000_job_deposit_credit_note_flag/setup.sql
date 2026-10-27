-- Pre-migration surface for the deposit credit note flag. The earlier registered case
-- 20261026160000_job_deposit_advance creates public.job_deposit_advance_state (and the
-- cases before it prepare public.jobs), so this case needs nothing more.
SELECT 1;
