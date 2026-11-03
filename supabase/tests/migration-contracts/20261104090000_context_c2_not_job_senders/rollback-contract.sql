-- After the undo the reason step is the 20260924183000 definition again, word for word, and the trigger, both functions
-- and the (empty) register are gone; the reason step keeps its grants.
DO $$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_bucket_reason_detail(public.business_events,jsonb)'::regprocedure)
    <> '78cad84dc555a47155e6bc614bbba3b8' THEN
  RAISE EXCEPTION 'c2 not-job senders rollback: the reason step is not the old definition';
 END IF;
 IF to_regprocedure('public.context_not_job_sender(public.business_events)') IS NOT NULL
 OR to_regprocedure('public.context_entity_contact_fill()') IS NOT NULL
 OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.business_events'::regclass AND tgname = 'context_a0_entity_contact')
 OR to_regclass('public.context_sender_register') IS NOT NULL THEN
  RAISE EXCEPTION 'c2 not-job senders rollback: the trigger, a function or the register is still there';
 END IF;
 IF has_function_privilege('anon', 'public.context_bucket_reason_detail(public.business_events,jsonb)', 'EXECUTE') THEN
  RAISE EXCEPTION 'c2 not-job senders rollback: the reason step gained a grant';
 END IF;
END $$;
-- The legacy reason step still answers.
SELECT public.context_bucket_reason_detail(jsonb_populate_record(NULL::public.business_events, $j${"event_type":"client.email_in","direction":"inbound","payload":{"from":"someone@example.org","subject":"hello"}}$j$::jsonb), NULL)->>'reason' AS legacy_reason;
