-- C1c setup. Earlier registered context fixtures supply business_events at the
-- live production shape (C1a setup: the live channel, direction, privacy and
-- retention CHECKs), jobs, the ladder (the live 20260923230000 body), the
-- capture lane and capture_business_event. This file only proves that starting
-- point and that neither C1c object exists yet (as in production: the objects
-- are new in this migration).
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.capture_business_event(jsonb)'))
    IS DISTINCT FROM '4819869e6dcc40d5cd19a7eba295392c'
 THEN RAISE EXCEPTION 'c1c setup: capture_business_event is not the C1a body'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.resolve_context_attribution(public.business_events)'))
    IS DISTINCT FROM 'acb80ebe792beeb7e5b537643bf9f184'
 THEN RAISE EXCEPTION 'c1c setup: resolve_context_attribution is not the live body'; END IF;
 IF to_regclass('public.ghl_webhook_receipts') IS NOT NULL OR to_regprocedure('public.record_ghl_webhook_receipt(jsonb)') IS NOT NULL
 THEN RAISE EXCEPTION 'c1c setup: C1c objects already exist'; END IF;
END $$;
