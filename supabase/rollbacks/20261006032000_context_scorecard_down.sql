-- Rollback of 20261006032000_context_scorecard.
--
-- Drops the scorecard's four read-only functions. Nothing else was created or
-- changed: no table, row, flag, cron job or grant on any other object.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DROP FUNCTION IF EXISTS public.context_scorecard_jobs(uuid, integer, timestamptz);
DROP FUNCTION IF EXISTS public.context_scorecard(timestamptz);
DROP FUNCTION IF EXISTS public.context_scorecard_lane_of(text, text, text, text, text, jsonb);
DROP FUNCTION IF EXISTS public.context_scorecard_policy();
