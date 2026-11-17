-- Prerequisites for 20261117171001_job_change_marks: public.jobs and the organisation
-- 00000000-0000-0000-0000-000000000001, both from the earlier registered setups. The ZZTEST-401 job is made inside
-- the contract's own rolled-back transaction, so this setup only checks the stack has what it needs.
DO $$
BEGIN
 IF to_regclass('public.jobs') IS NULL THEN
  RAISE EXCEPTION 'job change marks setup: public.jobs missing from the registered stack';
 END IF;
END $$;
