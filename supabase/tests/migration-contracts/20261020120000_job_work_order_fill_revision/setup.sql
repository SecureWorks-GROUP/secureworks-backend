-- Prerequisites for 20261020120000_job_work_order_fill_revision: jobs,
-- work_orders with the job work order layer (20261012130000, 20261016120000)
-- and the API roles come from earlier registered setups. scope_revisions is
-- not in the registered stack, so a minimal copy of the columns this contract
-- reads is created here (the real table, 20260504090757, has these with the
-- same names and status values).
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.jobs', 'public.work_orders'] LOOP
  IF to_regclass(t) IS NULL THEN RAISE EXCEPTION 'fill revision setup: % missing from the registered stack', t; END IF;
 END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS public.scope_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  revision_number int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'frozen', 'superseded'))
);
