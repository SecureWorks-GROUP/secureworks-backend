-- Puts back the stack's own v_job_profit, kept by this case's setup.sql, after 20261104080000's down has taken the
-- stack to production's 20261103171500 definition. For the older job profit contracts (20261009100000,
-- 20261029160000) that unwind TP-13: they then read the definition they were written against, as before this case
-- was registered. Production's and the stack's definitions have the same columns, so the view is replaced in place.
DO $$
DECLARE
  d text;
BEGIN
  SELECT definition INTO STRICT d FROM public.contract_jp_preimage WHERE object = 'v_job_profit';
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_profit AS ' || d;
END $$;
