-- Earlier registered migrations provide the three live preimages and fixtures.
DO $$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.trigger_context_email_poll()'::regprocedure)<>'1430e54e4443b839865d3b4874793e15'
 THEN RAISE EXCEPTION 'sweep setup poll preimage'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.trigger_context_email_sweep()'::regprocedure)<>'9e375b43beb7dc236b44dd5bd0b131d7'
 THEN RAISE EXCEPTION 'sweep setup nightly preimage'; END IF;
END $$;
