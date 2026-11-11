-- After the down: the record and both functions are gone, and jobs and
-- job_events are untouched.
DO $$
BEGIN
  ASSERT to_regclass('public.job_deposit_gate_overrides') IS NULL, 'table dropped';
  ASSERT to_regprocedure('public.grant_job_deposit_gate_override(uuid,uuid,text,jsonb)') IS NULL
    AND to_regprocedure('public.revoke_job_deposit_gate_override(uuid,uuid,text)') IS NULL, 'functions dropped';
  ASSERT to_regclass('public.jobs') IS NOT NULL AND to_regclass('public.job_events') IS NOT NULL, 'jobs and history remain';
END $$;
