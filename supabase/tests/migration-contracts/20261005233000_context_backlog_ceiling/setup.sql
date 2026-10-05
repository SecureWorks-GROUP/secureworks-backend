-- Earlier registered context fixtures supply jobs, business_events, the run
-- ledger, the reservations, K1, the catch-up list (20260924220000) and its
-- backlog scope (20261004100000). Prove the three functions this migration
-- replaces are still their repository bodies (production's pre-image), so the
-- contract runs from production's starting point.
DO $$
DECLARE x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_jobs_cadence(uuid[])','184bfbf98717e2a85cfaed282bcca9a6'),
  ('public.context_cadence_status()','552d7971757d43624ec3667e3dc1fb99'),
  ('public.claim_context_extraction_run(uuid,date,text)','ac6f021c77dbf0e44a949ea94d24f666')) AS t(sig,md5) LOOP
  SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid=to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.md5 THEN RAISE EXCEPTION 'backlog ceiling setup: % is not the pre-image (%)',x.sig,live; END IF;
 END LOOP;
 IF to_regclass('public.context_cadence_settings') IS NOT NULL THEN RAISE EXCEPTION 'backlog ceiling setup: settings table already exists'; END IF;
END $$;
-- The policy before this migration, so the contract can prove every cap and
-- live_since are untouched.
DROP TABLE IF EXISTS public.ceiling_contract_policy_preimage;
CREATE TABLE public.ceiling_contract_policy_preimage AS SELECT public.context_cadence_policy() AS p;
