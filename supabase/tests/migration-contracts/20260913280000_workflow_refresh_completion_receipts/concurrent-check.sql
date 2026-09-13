SET ROLE service_role;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.workflow_refresh_runs
      WHERE workflow='dispatch'
        AND scope = '{"job_id":"28000000-0000-4000-8000-000000000010","org_id":"00000000-0000-0000-0000-000000000001"}'::jsonb
        AND status IN ('queued','running')) <> 1 THEN
    RAISE EXCEPTION 'concurrent start did not coalesce to one active run';
  END IF;
  RAISE NOTICE 'Concurrent Refresh start sessions coalesced to one active run';
END $$;
