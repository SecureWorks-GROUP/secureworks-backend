-- Prerequisites for 20261115130000_job_cost_close. Earlier registered cases supply Job Profit's view, the jobs
-- table, client sign-offs and the make-safe details table. Fail closed, by name, if any of it is gone.
-- The registered stack's make-safe details table has no attendance columns: production's has both (cycle_number
-- integer NOT NULL DEFAULT 1, reopen_reason text, read 15 Nov 2026), added by no migration this stack applies.
-- They are added here, as production has them, so the migration's own guard passes. Production's service role
-- reads that table (read 15 Nov 2026); the stack's does not, so that grant is stood up here too.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.v_job_profit', 'public.jobs', 'public.job_client_signoffs',
                           'public.makesafe_job_details', 'public.job_events',
                           'public.job_materials_facts', 'public.xero_invoices', 'public.purchase_orders'] LOOP
    IF to_regclass(t) IS NULL THEN
      RAISE EXCEPTION 'job cost close setup: % missing from the registered stack', t;
    END IF;
  END LOOP;
  IF to_regprocedure('public.job_profit_partial_cost_policy()') IS NULL THEN
    RAISE EXCEPTION 'job cost close setup: job_profit_partial_cost_policy() missing from the registered stack';
  END IF;
END $$;

ALTER TABLE public.makesafe_job_details
  ADD COLUMN IF NOT EXISTS cycle_number integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS reopen_reason text;
GRANT SELECT ON public.makesafe_job_details TO service_role;
GRANT SELECT ON public.job_events TO service_role;
-- ops-api changes job statuses as the service role, which on production holds every right on jobs (read 15 Nov
-- 2026). The contract changes a status as that role to prove the status record is written for a caller that
-- cannot write the record itself.
GRANT SELECT, UPDATE ON public.jobs TO service_role;
-- Production's jobs carries is_callback (boolean, default false, read 15 Nov 2026), added by no migration this
-- stack applies; its service role reads job_assignments. Both stood up here as production has them.
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS is_callback boolean DEFAULT false;
GRANT SELECT ON public.job_assignments TO service_role;
