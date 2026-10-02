-- Earlier registered context fixtures supply jobs, business_events, K1 and
-- the catch-up. Prove both readers this migration replaces are still their
-- repository bodies (production's pre-image), so the contract runs from
-- production's starting point.
DO $$
DECLARE x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_unread_rows(uuid[])','d426adcccab139a188ee158e14ca4fb1'),
  ('public.context_catchup_eligible_rows(uuid[])','d028f0366b62e828b43edb7bd650828b')) AS t(sig,md5) LOOP
  SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid=to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.md5 THEN RAISE EXCEPTION 'source admission setup: % is not the production pre-image (%)',x.sig,live; END IF;
 END LOOP;
END $$;
