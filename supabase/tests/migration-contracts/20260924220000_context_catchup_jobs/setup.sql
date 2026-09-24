-- Earlier registered context fixtures supply jobs, business_events, the run
-- ledger and K1. Prove every function this migration replaces is still K1's
-- body (production's pre-image), so the contract runs from production's
-- starting point.
DO $$
DECLARE x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_jobs_cadence(uuid[])','71db787a8a80b5519b5a5c9b8d915d5c'),
  ('public.context_cadence_pool()','6943c7ed49e09cddc23a517255805fba'),
  ('public.context_extraction_candidates(integer)','0257dc0ea9c35a249b3b8adcb99a18d4'),
  ('public.context_cadence_status()','04a99b46fbdf6b6ac830602da6a92c3d')) AS t(sig,md5) LOOP
  SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid=to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.md5 THEN RAISE EXCEPTION 'catch-up setup: % is not the production pre-image (%)',x.sig,live; END IF;
 END LOOP;
END $$;
-- The policy as it stands before this migration, so the contract can prove
-- the migration leaves every cap number and live_since untouched.
DROP TABLE IF EXISTS public.catchup_contract_policy_preimage;
CREATE TABLE public.catchup_contract_policy_preimage AS SELECT public.context_cadence_policy() AS p;
