-- An attributed office sign-off counts; a revoked one does not.
BEGIN;
DO $$
DECLARE job uuid := 'f0300000-0000-4000-8000-000000000101';
BEGIN
  INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES(job,'00000000-0000-0000-0000-000000000001','patio','quoted','SYN-OFFICE-SIGNOFF');
  INSERT INTO public.job_client_signoffs(job_id,method,waiver_reason,captured_by_actor,created_at)
    VALUES(job,'office_waiver','Owner authorised office sign-off','user:synthetic',clock_timestamp());
  IF NOT public.group_client_signoff_counts(job) THEN RAISE EXCEPTION 'attributed office sign-off did not count'; END IF;
  INSERT INTO public.job_client_signoffs(job_id,method,captured_by_actor,created_at)
    VALUES(job,'revoked','user:synthetic',clock_timestamp() + interval '1 second');
  IF public.group_client_signoff_counts(job) THEN RAISE EXCEPTION 'revoked sign-off still counted'; END IF;
END $$;
SELECT 'PASS: office sign-off counts with reason and actor; revoke clears it' AS result;
ROLLBACK;
