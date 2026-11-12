-- After the down migration a restoration request falls back to SW- again.
BEGIN;
DO $$
BEGIN
  IF public.next_job_number('restoration') NOT LIKE 'SW-%' THEN
    RAISE EXCEPTION 'rollback must remove the restoration branch';
  END IF;
  IF public.next_job_number('makesafe') NOT LIKE 'SWMS-%' THEN
    RAISE EXCEPTION 'rollback must keep makesafe SWMS-';
  END IF;
END $$;
ROLLBACK;
