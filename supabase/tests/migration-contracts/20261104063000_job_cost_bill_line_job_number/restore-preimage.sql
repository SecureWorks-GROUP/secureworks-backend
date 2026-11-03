-- Puts back the stack's own v_job_cost_events and cfo_bill_cost_outcomes_scoped, kept by this case's setup.sql.
-- For the older cost contracts (20261030010000, 20261030060000), after 20261104063000_job_cost_bill_line_job_number's down, inside their own
-- transaction or disposable copy, so they read their own definitions as before.
DO $$
DECLARE
  d text;
BEGIN
  SELECT definition INTO STRICT d FROM public.contract_v8_preimage WHERE object = 'v_job_cost_events';
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_cost_events AS ' || d;
  SELECT definition INTO STRICT d FROM public.contract_v8_preimage WHERE object = 'cfo_bill_cost_outcomes_scoped';
  EXECUTE d;
END $$;
