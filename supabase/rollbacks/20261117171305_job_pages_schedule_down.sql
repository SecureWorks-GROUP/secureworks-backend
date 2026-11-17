-- Remove explicitly installed hooks before removing activation and schedule definitions.
SET LOCAL lock_timeout = '5s';
SELECT public.job_pages_remove();
DROP FUNCTION IF EXISTS public.job_pages_install();
DROP FUNCTION IF EXISTS public.job_pages_remove();
DROP FUNCTION IF EXISTS public.job_pages_nightly(integer);
DROP FUNCTION IF EXISTS public.job_pages_keep_ready_set();
