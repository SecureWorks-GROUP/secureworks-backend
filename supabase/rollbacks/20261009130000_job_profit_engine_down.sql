-- Rollback of 20261009130000_job_profit_engine: drops the read-only job profit
-- engine (one function, three views, one helper). Nothing else reads them in
-- the database; ops-api job_profit / job_profit_list stop answering until the
-- migration is re-applied. No row is written or deleted. job_financials and
-- get_job_financials are untouched either way.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DROP FUNCTION IF EXISTS public.job_profit(uuid);
DROP VIEW IF EXISTS public.v_job_profit;
DROP VIEW IF EXISTS public.v_job_revenue_events;
DROP VIEW IF EXISTS public.v_job_cost_events;
DROP FUNCTION IF EXISTS public.job_profit_num(jsonb);
