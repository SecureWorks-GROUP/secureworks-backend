-- T2b contract: a call waiting for its agreeing second read is served before
-- every never-read call, whatever the backlog; everything else about the
-- selection is T2's. Every fixture write is rolled back. Call ids are synthetic.

CREATE FUNCTION pg_temp.t2b_call(p_id text,p_at timestamptz,p_status text DEFAULT 'completed',p_duration numeric DEFAULT 60) RETURNS uuid LANGUAGE sql AS $$
 INSERT INTO public.business_events(event_type,source,entity_type,entity_id,contact_id,event_at,provider_message_id,channel,direction,payload,metadata)
 VALUES('client.call_logged','ghl-message-reconcile','contact','t2bContact001','t2bContact001',p_at,'ghl:'||p_id,'call','inbound',
  jsonb_build_object('call_status',p_status,'duration_seconds',p_duration,'from_line','774','ghl_message_id',p_id,'call_sid','CAfixture'),
  '{"capture_mode":"live"}') RETURNING id
$$;
CREATE FUNCTION pg_temp.t2b_rec(p_id text,p_result text,p_due boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM public.record_call_transcript_fetch(jsonb_build_object('call_message_id',p_id,
  'call_event_id',(SELECT id FROM public.business_events WHERE provider_message_id='ghl:'||p_id),'result',p_result)
  || CASE WHEN p_result='awaiting_agreement' THEN jsonb_build_object('sentences',12,'digest',repeat('c',64))
          ELSE jsonb_build_object('code','empty') END);
 IF p_due THEN UPDATE public.call_transcript_fetches SET next_at=now()-interval '1 minute' WHERE call_message_id=p_id; END IF;
END $$;
CREATE FUNCTION pg_temp.t2b_due(p_limit integer) RETURNS text LANGUAGE sql AS $$
 SELECT coalesce(string_agg(x.call_message_id,' ' ORDER BY x.n),'')
 FROM public.context_transcript_due_calls(p_limit) WITH ORDINALITY x(call_event_id,call_message_id,event_type,event_at,contact_id,
  conversation_key,direction,call_status,duration_seconds,call_sid,line,from_line,by_user,capture_mode,transcript_event_id,attempts,
  seen_sentences,seen_digest,seen_at,job_numbers,fetch_mode,n)
$$;

BEGIN;
-- 1. A backlog of never-read calls older than two calls waiting for their
-- second read: the second reads come first (oldest of them first), then the
-- backlog oldest first, then a due error retry in its age order. A second
-- read not yet due and a terminal call are not offered.
SELECT pg_temp.t2b_call('t2bBacklog01',now()-interval '10 days');
SELECT pg_temp.t2b_call('t2bBacklog02',now()-interval '9 days');
SELECT pg_temp.t2b_call('t2bBacklog03',now()-interval '8 days');
SELECT pg_temp.t2b_call('t2bRetryDue1',now()-interval '6 hours');
SELECT pg_temp.t2b_call('t2bSecondA01',now()-interval '3 hours');
SELECT pg_temp.t2b_call('t2bSecondB01',now()-interval '1 hour');
SELECT pg_temp.t2b_call('t2bSecondEarly',now()-interval '30 minutes');
SELECT pg_temp.t2b_call('t2bVoicemail1',now()-interval '2 hours','voicemail',NULL);
DO $$
DECLARE got text;
BEGIN
 PERFORM pg_temp.t2b_rec('t2bRetryDue1','not_ready',true);
 PERFORM pg_temp.t2b_rec('t2bSecondA01','awaiting_agreement',true);
 PERFORM pg_temp.t2b_rec('t2bSecondB01','awaiting_agreement',true);
 PERFORM pg_temp.t2b_rec('t2bSecondEarly','awaiting_agreement',false);
 -- What the fetcher now writes for a voicemail GHL cannot transcribe: terminal at once.
 PERFORM public.record_call_transcript_fetch(jsonb_build_object('call_message_id','t2bVoicemail1',
  'call_event_id',(SELECT id FROM public.business_events WHERE provider_message_id='ghl:t2bVoicemail1'),
  'result','not_expected','code','voicemail_no_transcript','provider_status','voicemail'));

 got:=pg_temp.t2b_due(2);
 IF got IS DISTINCT FROM 't2bSecondA01 t2bSecondB01'
 THEN RAISE EXCEPTION 't2b second reads first: a full page must start with the due second reads, got %',got; END IF;
 got:=pg_temp.t2b_due(40);
 IF got IS DISTINCT FROM 't2bSecondA01 t2bSecondB01 t2bBacklog01 t2bBacklog02 t2bBacklog03 t2bRetryDue1'
 THEN RAISE EXCEPTION 't2b due order %',got; END IF;
 IF (SELECT outcome||':'||coalesce(last_code,'')||':'||attempts FROM public.call_transcript_fetches WHERE call_message_id='t2bVoicemail1')
    IS DISTINCT FROM 'not_expected:voicemail_no_transcript:0'
 THEN RAISE EXCEPTION 't2b voicemail record is not terminal at once'; END IF;
 -- The second read still carries the first read the agreement rule compares with.
 IF (SELECT row(d.seen_sentences,d.seen_digest,d.attempts)::text FROM public.context_transcript_due_calls(1) d)
    IS DISTINCT FROM format('(12,%s,0)',repeat('c',64))
 THEN RAISE EXCEPTION 't2b second read row shape'; END IF;
END $$;
ROLLBACK;

-- 2. The body, comment and grants.
DO $$
DECLARE r text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_transcript_due_calls(integer,boolean)'::regprocedure)<>'4e67b697860f6206c30d1e107dd62677'
 THEN RAISE EXCEPTION 't2b body md5'; END IF;
 IF obj_description('public.context_transcript_due_calls(integer,boolean)'::regprocedure,'pg_proc') NOT LIKE 'T2b:%'
 THEN RAISE EXCEPTION 't2b comment'; END IF;
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF has_function_privilege(r,'public.context_transcript_due_calls(integer,boolean)','EXECUTE')
  THEN RAISE EXCEPTION 't2b: % can call the due-call selection',r; END IF;
 END LOOP;
 IF NOT has_function_privilege('service_role','public.context_transcript_due_calls(integer,boolean)','EXECUTE')
 THEN RAISE EXCEPTION 't2b: service_role lost the due-call selection'; END IF;
END $$;
