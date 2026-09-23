-- Rollback for 20260923190000_job_quote_values (context D1).
--
-- Drops the read-only quote value function. It owns no table and no rows, so
-- nothing is lost. Deployed ops-api code that calls it keeps working: the job
-- read and the invoice read report the quote section as failed with the
-- missing-function code instead of a value (never "nothing quoted").
-- Redeploy the previous ops-api to remove the calls entirely.

DROP FUNCTION IF EXISTS public.job_quote_values(uuid);
