-- Rollback contract: 20261014113000_job_dispatch_state. The down drops the Dispatch stage table and
-- nothing else: jobs and users remain.
\set ON_ERROR_STOP on
DO $$
BEGIN
 IF to_regclass('public.job_dispatch_state') IS NOT NULL THEN
  RAISE EXCEPTION 'job dispatch state rollback contract: job_dispatch_state still exists';
 END IF;
 IF to_regclass('public.jobs') IS NULL OR to_regclass('public.users') IS NULL THEN
  RAISE EXCEPTION 'job dispatch state rollback contract: the down removed a table it does not own';
 END IF;
END $$;
