-- After the down: the selection is T2's again, byte for byte, with T2's
-- comment and grants, and due calls are oldest first again (a second read
-- waits behind an older never-read call).
\set ON_ERROR_STOP 1
DO $$
DECLARE r text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_transcript_due_calls(integer,boolean)'::regprocedure)<>'74d87e872300c883676c6ed8a3188023'
 THEN RAISE EXCEPTION 't2b rollback: the selection is not T2''s body'; END IF;
 IF obj_description('public.context_transcript_due_calls(integer,boolean)'::regprocedure,'pg_proc') NOT LIKE 'Calls due a transcript fetch now (transcripts slice T2)%'
 THEN RAISE EXCEPTION 't2b rollback: T2''s comment is not restored'; END IF;
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF has_function_privilege(r,'public.context_transcript_due_calls(integer,boolean)','EXECUTE')
  THEN RAISE EXCEPTION 't2b rollback: % can call the due-call selection',r; END IF;
 END LOOP;
 IF NOT has_function_privilege('service_role','public.context_transcript_due_calls(integer,boolean)','EXECUTE')
 THEN RAISE EXCEPTION 't2b rollback: service_role lost the due-call selection'; END IF;
END $$;
BEGIN;
INSERT INTO public.business_events(event_type,source,entity_type,entity_id,contact_id,event_at,provider_message_id,channel,direction,payload,metadata)
VALUES('client.call_logged','ghl-message-reconcile','contact','t2bContact001','t2bContact001',now()-interval '9 days','ghl:t2bBacklog01','call','inbound',
  '{"call_status":"completed","duration_seconds":60}','{"capture_mode":"live"}'),
 ('client.call_logged','ghl-message-reconcile','contact','t2bContact001','t2bContact001',now()-interval '1 hour','ghl:t2bSecondB01','call','inbound',
  '{"call_status":"completed","duration_seconds":60}','{"capture_mode":"live"}');
DO $$
BEGIN
 PERFORM public.record_call_transcript_fetch(jsonb_build_object('call_message_id','t2bSecondB01',
  'call_event_id',(SELECT id FROM public.business_events WHERE provider_message_id='ghl:t2bSecondB01'),
  'result','awaiting_agreement','sentences',12,'digest',repeat('c',64)));
 UPDATE public.call_transcript_fetches SET next_at=now()-interval '1 minute' WHERE call_message_id='t2bSecondB01';
 IF (SELECT d.call_message_id FROM public.context_transcript_due_calls(1) d) IS DISTINCT FROM 't2bBacklog01'
 THEN RAISE EXCEPTION 't2b rollback: T2''s order (oldest first) is not restored'; END IF;
END $$;
ROLLBACK;
