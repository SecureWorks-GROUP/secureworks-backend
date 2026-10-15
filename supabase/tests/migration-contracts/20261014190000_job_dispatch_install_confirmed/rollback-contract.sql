-- Rollback contract: 20261014190000_job_dispatch_install_confirmed. The down drops the four columns
-- and two checks and nothing else: job_dispatch_state and its slice 3 columns remain.
\set ON_ERROR_STOP on
DO $$
BEGIN
 IF to_regclass('public.job_dispatch_state') IS NULL THEN
  RAISE EXCEPTION 'install confirmed rollback contract: the down removed job_dispatch_state';
 END IF;
 IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
            AND table_name = 'job_dispatch_state' AND column_name LIKE 'install_confirmed%') THEN
  RAISE EXCEPTION 'install confirmed rollback contract: an install_confirmed column remains';
 END IF;
 IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
     AND table_name = 'job_dispatch_state' AND column_name IN ('stage', 'next_step', 'stage_set_by')) <> 3 THEN
  RAISE EXCEPTION 'install confirmed rollback contract: the down removed a slice 3 column';
 END IF;
END $$;
