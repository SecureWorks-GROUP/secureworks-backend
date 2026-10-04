-- Down migration for 20261004100000_context_catchup_backlog.
--
-- Drops the backlog writer, restores context_catchup_pending_rows to
-- 20260924220000's repository body (md5 checked at the end), deletes the
-- backlog rows not yet done (scope <> 'live_catchup' and done_at is null,
-- exactly the stop statement), drops mode and scope, and restores the 1..2
-- priority check. Done backlog rows are history and stay; any still carrying a
-- priority above 2 is set to 2 so the restored check holds (a done row's
-- priority orders nothing). The original catch-up rows, the read record and
-- live reads are untouched.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DROP FUNCTION IF EXISTS public.context_catchup_request_backlog(integer,boolean,integer);

CREATE OR REPLACE FUNCTION public.context_catchup_pending_rows(p_job_ids uuid[]) RETURNS SETOF public.business_events
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT e.* FROM public.context_catchup_eligible_rows(p_job_ids) e
 JOIN public.context_catchup_jobs c ON c.job_id=e.job_id AND c.done_at IS NULL
 WHERE NOT EXISTS(SELECT 1 FROM public.context_catchup_reads r WHERE r.job_id=e.job_id AND r.event_id=e.id)
$$;
COMMENT ON FUNCTION public.context_catchup_pending_rows(uuid[]) IS
 'Catch-up: rows on listed, not-yet-done jobs that no catch-up read has covered, earlier receipts or not. Service role only.';
REVOKE ALL ON FUNCTION public.context_catchup_pending_rows(uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_catchup_pending_rows(uuid[]) TO service_role;

DELETE FROM public.context_catchup_jobs WHERE done_at IS NULL AND scope<>'live_catchup';
UPDATE public.context_catchup_jobs SET priority=2 WHERE priority>2 AND done_at IS NOT NULL;

ALTER TABLE public.context_catchup_jobs DROP CONSTRAINT IF EXISTS context_catchup_jobs_priority_check;
ALTER TABLE public.context_catchup_jobs DROP COLUMN IF EXISTS mode, DROP COLUMN IF EXISTS scope;
ALTER TABLE public.context_catchup_jobs ADD CONSTRAINT context_catchup_jobs_priority_check CHECK (priority IN (1,2));
COMMENT ON TABLE public.context_catchup_jobs IS
 'Catch-up: jobs to give one fresh full read regardless of live_since (20260924220000). Written by context_catchup_request; done_at is set by the first done extraction run that leaves the job with no pending rows. Service role only.';

DO $$
DECLARE live text;
BEGIN
 SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid=to_regprocedure('public.context_catchup_pending_rows(uuid[])');
 IF live IS DISTINCT FROM '153a4a0e10b566445a029f0785c096ff' THEN RAISE EXCEPTION 'catch-up backlog rollback: context_catchup_pending_rows body is %',live; END IF;
END $$;
