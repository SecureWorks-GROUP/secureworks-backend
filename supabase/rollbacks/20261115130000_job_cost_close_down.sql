-- Rollback for 20261115130000_job_cost_close.sql. The two functions are read only and nothing is stored, so
-- dropping them loses nothing. Drop ops-api's reader first or its cost_close key answers ok:false.
SET LOCAL lock_timeout = '5s';
DROP FUNCTION IF EXISTS public.job_cost_close(uuid[], date);
DROP FUNCTION IF EXISTS public.job_cost_close_policy();
