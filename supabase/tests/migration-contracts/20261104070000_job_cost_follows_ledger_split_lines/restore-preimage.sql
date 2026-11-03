-- Puts back the stack's own v_job_cost_events, kept by this case's setup.sql: for the older cost contracts after
-- the A6 downs (20261104072000, 20261104071000, 20261104070000), inside their own transaction or disposable copy.
DO $$
DECLARE
  d text;
BEGIN
  SELECT definition INTO STRICT d FROM public.contract_a6_preimage WHERE object = 'v_job_cost_events';
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_cost_events AS ' || d;
END $$;
