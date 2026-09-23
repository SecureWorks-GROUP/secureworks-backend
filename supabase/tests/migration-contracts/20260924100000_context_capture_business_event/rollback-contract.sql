-- After rollback: the writer is gone and business_events is untouched.
DO $$
BEGIN
 IF to_regprocedure('public.capture_business_event(jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'c1a rollback: capture_business_event still exists'; END IF;
 IF to_regclass('public.business_events_provider_message_unique') IS NULL THEN RAISE EXCEPTION 'c1a rollback: provider message index gone'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.resolve_context_attribution(public.business_events)'))<>'acb80ebe792beeb7e5b537643bf9f184'
 THEN RAISE EXCEPTION 'c1a rollback: the ladder changed'; END IF;
END $$;
