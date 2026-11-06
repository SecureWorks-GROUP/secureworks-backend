\set ON_ERROR_STOP on
DO $$
BEGIN
  IF (SELECT count(*) FROM public.jobs WHERE org_id = '00000000-0000-4000-8000-0000000000e1') IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'concurrent starts made % jobs, expected exactly one',
      (SELECT count(*) FROM public.jobs WHERE org_id = '00000000-0000-4000-8000-0000000000e1');
  END IF;
END $$;
DELETE FROM public.fence_job_mint_locks WHERE org_id = '00000000-0000-4000-8000-0000000000e1';
DELETE FROM public.fence_job_mint_requests WHERE org_id = '00000000-0000-4000-8000-0000000000e1' AND owner_request_id IS NOT NULL;
DELETE FROM public.fence_job_mint_requests WHERE org_id = '00000000-0000-4000-8000-0000000000e1';
DELETE FROM public.job_events WHERE job_id IN (SELECT id FROM public.jobs WHERE org_id = '00000000-0000-4000-8000-0000000000e1');
DELETE FROM public.jobs WHERE org_id = '00000000-0000-4000-8000-0000000000e1';
DELETE FROM public.users WHERE org_id = '00000000-0000-4000-8000-0000000000e1';
DELETE FROM public.organisations WHERE id = '00000000-0000-4000-8000-0000000000e1';
