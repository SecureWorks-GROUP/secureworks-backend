-- Down for 20261105160000_dispatch_v2_order_crew_lines. Roll back ops-api
-- first (dispatch_v2_order_confirmed_write.ts names the table). The notes
-- already written stay in the crew thread (job_events); only the memory of
-- which lines were written goes, so after a roll forward an order confirmed
-- again would get its line again.
DROP TABLE IF EXISTS public.dispatch_v2_order_crew_lines;
