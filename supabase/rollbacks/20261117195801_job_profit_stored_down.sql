-- P0-09.2/.3 undo, before any later stored reader/trigger installation.
SET LOCAL lock_timeout = '5s';
DROP FUNCTION IF EXISTS public.job_profit_stored_compare(integer);
DROP FUNCTION IF EXISTS public.job_profit_refresh_all();
DROP FUNCTION IF EXISTS public.job_profit_refresh_marked(integer);
DROP FUNCTION IF EXISTS public.job_profit_refresh(uuid);
DROP FUNCTION IF EXISTS public.job_profit_refresh_many(uuid[]);
DROP FUNCTION IF EXISTS public.job_profit_mark(uuid,text);
DROP TABLE IF EXISTS public.job_profit_dirty;
DROP TABLE IF EXISTS public.job_revenue_events_stored;
DROP TABLE IF EXISTS public.job_cost_events_stored;
DROP TABLE IF EXISTS public.job_profit_stored;
DELETE FROM public.feature_flags WHERE flag_name='job_profit_stored_read_v1';
