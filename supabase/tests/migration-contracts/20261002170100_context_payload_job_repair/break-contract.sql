-- Ship the repair as a real run by default. The contract must catch it.
DO $$
BEGIN
 EXECUTE replace(pg_get_functiondef('public.context_payload_job_repair(boolean,integer)'::regprocedure),
  'p_dry_run boolean DEFAULT true','p_dry_run boolean DEFAULT false');
END $$;
