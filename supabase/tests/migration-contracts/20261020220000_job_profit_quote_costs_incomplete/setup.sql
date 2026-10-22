-- Prerequisites for 20261020220000_job_profit_quote_costs_incomplete.
-- Earlier registered cases create everything this migration reads: the engine
-- views (20261009130000, CFO-12 20261019120000), quote_revisions and
-- job_documents. Fail closed if any is gone.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.v_job_profit', 'public.quote_revisions', 'public.job_documents'] LOOP
  IF to_regclass(t) IS NULL THEN
   RAISE EXCEPTION 'quote costs incomplete setup: % missing from the registered stack', t;
  END IF;
 END LOOP;
END $$;
