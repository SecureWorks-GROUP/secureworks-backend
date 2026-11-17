-- Reverse P0-01.1 after removing the page schedule.
SET LOCAL lock_timeout = '5s';
DROP FUNCTION IF EXISTS public.job_page_get(uuid);
DROP FUNCTION IF EXISTS public.job_pages_refresh_due(integer);
DROP FUNCTION IF EXISTS public.job_page_refresh(uuid);
DROP FUNCTION IF EXISTS public.job_page_version();
DROP TABLE IF EXISTS public.job_pages;
