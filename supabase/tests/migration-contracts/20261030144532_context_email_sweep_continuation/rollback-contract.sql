DO $$ BEGIN
 IF public.context_email_sweep_continuation_enabled() THEN RAISE EXCEPTION 'rollback flag still on'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.context_email_sweep_windows WHERE source_key='retained_fixture' AND state='pending') THEN RAISE EXCEPTION 'rollback lost pending work'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.trigger_context_email_poll()'::regprocedure)<>'1430e54e4443b839865d3b4874793e15'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.trigger_context_email_sweep()'::regprocedure)<>'9e375b43beb7dc236b44dd5bd0b131d7'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_email_capture_status_at(timestamptz)'::regprocedure)<>'ee6f8e5d57e41fe8c2691b59d4b51856'
 THEN RAISE EXCEPTION 'rollback preimages differ'; END IF;
END $$;
