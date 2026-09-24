DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.business_events'::regclass AND tgname='business_events_pair_legacy_call' AND NOT tgisinternal)
  OR to_regprocedure('public.pair_legacy_ghl_call()') IS NOT NULL
  OR to_regclass('public.business_events_legacy_call_pair_lookup') IS NOT NULL
 THEN RAISE EXCEPTION 'call pairing rollback left its objects'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_unread_rows(uuid[])'))
    IS DISTINCT FROM 'd426adcccab139a188ee158e14ca4fb1'
 THEN RAISE EXCEPTION 'call pairing rollback did not restore the K1 reader'; END IF;
END $$;
