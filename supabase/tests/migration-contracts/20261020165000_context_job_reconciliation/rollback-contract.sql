-- After the down migration both reads are gone and the decision store is untouched.
\set ON_ERROR_STOP 1
DO $$
BEGIN
  IF to_regprocedure('public.context_job_mail(uuid,int,text[])') IS NOT NULL
     OR to_regprocedure('public.context_recon_job_items(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'job recon rollback: functions remain';
  END IF;
  IF to_regprocedure('public.context_event_jobs(uuid)') IS NULL
     OR to_regclass('public.context_reconciliation_decisions') IS NULL THEN
    RAISE EXCEPTION 'job recon rollback: decision store touched';
  END IF;
END $$;
