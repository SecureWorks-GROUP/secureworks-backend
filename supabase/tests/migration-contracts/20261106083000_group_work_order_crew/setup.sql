DO $$ BEGIN
 IF to_regprocedure('public.group_work_order_write_split(uuid,boolean)') IS NULL
   OR to_regclass('public.group_work_order_participants') IS NULL THEN
  RAISE EXCEPTION 'shared group crew prerequisites are missing';
 END IF;
END $$;
ALTER TABLE public.job_assignments ADD COLUMN IF NOT EXISTS is_ghost boolean DEFAULT false;
CREATE TABLE IF NOT EXISTS public.migration_contract_group_crew_before(body text);
TRUNCATE public.migration_contract_group_crew_before;
INSERT INTO public.migration_contract_group_crew_before
SELECT pg_get_functiondef('public.group_work_order_write_split(uuid,boolean)'::regprocedure);
