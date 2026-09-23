-- Earlier registered context fixtures supply jobs, business_events, the run
-- ledger, B2 attribution, B3 custody and the F1 foundation. The registered
-- stack leaves the 11 Sep trigger body; production runs the 14 Sep body
-- (without its comments), read from production on 23 Sep 2026. Install that
-- exact live text, then prove every object K1 replaces is production's
-- pre-image, so the contract runs from production's starting point.
CREATE OR REPLACE FUNCTION public.attribute_business_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.context_captured_at IS NULL THEN
    NEW.context_captured_at := clock_timestamp();
  END IF;
  NEW := public.resolve_context_attribution(NEW);
  RETURN NEW;
END $function$;
DO $$
DECLARE x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.attribute_business_event()','c399dfbebcd120a4b0741a9130a973bf'),
  ('public.claim_context_extraction_run(uuid,date,text)','220a8998c8c7d2803be2c9e9f0087cee'),
  ('public.claim_context_pass(date)','5085741c2f41def9244717b16f15ffb2'),
  ('public.renew_context_pass(date,uuid)','a45e3fd2e2d7ef34ea323deddfb9abe6'),
  ('public.finish_context_pass(date,uuid,text,timestamptz,text)','d41992ac30bea7c884a5856395c233cd'),
  ('public.context_extraction_events(uuid,integer)','b20069eae64c43cf4d9315f6ffc8e2b7'),
  ('public.context_extraction_candidates(integer)','6428bee63b2db436dbe1c6dcaeafd69e'),
  ('public.context_cadence_status()','155104bfb08b8b3c2f98bdec089d4ee4'),
  ('public.context_ready_jobs_count(integer)','67e55f87c9e53c4f6640a0936d8d279b')) AS t(sig,md5) LOOP
  SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid=to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.md5 THEN RAISE EXCEPTION 'k1 setup: % is not the production pre-image (%)',x.sig,live; END IF;
 END LOOP;
END $$;
