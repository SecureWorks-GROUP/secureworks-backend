DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.capture_business_event(jsonb)'))
    IS DISTINCT FROM '4819869e6dcc40d5cd19a7eba295392c'
 THEN RAISE EXCEPTION 'call pairing setup: capture_business_event is not the expected writer'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_unread_rows(uuid[])'))
    IS DISTINCT FROM 'd426adcccab139a188ee158e14ca4fb1'
 THEN RAISE EXCEPTION 'call pairing setup: context_unread_rows is not the K1 reader'; END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.business_events'::regclass AND tgname='business_events_pair_legacy_call' AND NOT tgisinternal)
 THEN RAISE EXCEPTION 'call pairing setup: pairing trigger already exists'; END IF;
END $$;
