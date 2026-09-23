-- C1a behaviour contract: capture_business_event, the one writer for new
-- evidence code, on the named rows of sms.md §10 (R5 tool-send race, R2, R7,
-- R13, R32 MMS). The input rows between the ROWS markers are exactly what the
-- TypeScript builder (_shared/evidence/ghl_message.ts) produces for the
-- recorded fixtures; ghl_message_contract_rows_test.ts fails if they drift.
-- Ids are the design's GHL ids; job ids and job numbers are synthetic; row
-- labels only. Every fixture write is rolled back.
BEGIN;
-- The live BEFORE INSERT trigger body, as read from production on 23 Sep 2026.
CREATE OR REPLACE FUNCTION public.attribute_business_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.context_captured_at IS NULL THEN
    NEW.context_captured_at := clock_timestamp();
  END IF;
  NEW := public.resolve_context_attribution(NEW);
  RETURN NEW;
END $$;
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.attribute_business_event()'))
    IS DISTINCT FROM 'c399dfbebcd120a4b0741a9130a973bf'
 THEN RAISE EXCEPTION 'c1a contract: attribute_business_event is not the live body'; END IF;
END $$;

CREATE TEMP TABLE c1a_rows(label text PRIMARY KEY, r jsonb NOT NULL) ON COMMIT DROP;
-- ROWS BEGIN
INSERT INTO c1a_rows(label,r) VALUES
 ('r5_tool','{"event_type":"client.sms_out","source":"ghl-proxy","entity_type":"contact","entity_id":"1VHBzZX6DsjMZW2WbgQn","contact_id":"1VHBzZX6DsjMZW2WbgQn","job_id":"33333333-3333-4333-8333-333333333335","match_method":"direct_job_id","event_at":null,"provider_message_id":"ghl:mDS89hMzWE2R3VCMqxP2","channel":"sms","direction":"outbound","thread_key":null,"conversation_key":"r5-conversation-placeholder","body_preview":"Install text for the R5 fixture.","safe_summary":"Install text for the R5 fixture.","body_hash":"sha256-r5","privacy_classification":"staff_only","retention_class":"7y_audit","payload":{"body":"Install text for the R5 fixture.","text":"Install text for the R5 fixture.","message":"Install text for the R5 fixture.","message_text":"Install text for the R5 fixture.","channel":"sms","direction":"outbound","ghl_message_id":"mDS89hMzWE2R3VCMqxP2","ghl_contact_id":"1VHBzZX6DsjMZW2WbgQn","ghl_message_type":"SMS","conversation_key":"r5-conversation-placeholder","conversation_id":"r5-conversation-placeholder","sent_by_kind":"our_tool","sent_by_user":null,"line":null,"from_line":"771","our_number":"+61489267771","provider_source":null,"provider_status":null,"attachments":{"count":0,"types":[]},"event_at_source":"missing","body_hash":"sha256-r5"},"metadata":{"capture_mode":"live"}}'::jsonb),
 ('r5_webhook','{"event_type":"client.sms_out","source":"ghl-webhook-receiver","entity_type":"contact","entity_id":"1VHBzZX6DsjMZW2WbgQn","contact_id":"1VHBzZX6DsjMZW2WbgQn","job_id":null,"match_method":"none","event_at":"2026-09-18T01:10:00.000Z","provider_message_id":"ghl:mDS89hMzWE2R3VCMqxP2","channel":"sms","direction":"outbound","thread_key":null,"conversation_key":"r5-conversation-placeholder","body_preview":"Install text for the R5 fixture.","safe_summary":"Install text for the R5 fixture.","privacy_classification":"staff_only","retention_class":"7y_audit","payload":{"body":"Install text for the R5 fixture.","text":"Install text for the R5 fixture.","message":"Install text for the R5 fixture.","message_text":"Install text for the R5 fixture.","channel":"sms","direction":"outbound","ghl_message_id":"mDS89hMzWE2R3VCMqxP2","ghl_contact_id":"1VHBzZX6DsjMZW2WbgQn","ghl_message_type":"SMS","conversation_key":"r5-conversation-placeholder","conversation_id":"r5-conversation-placeholder","sent_by_kind":"our_tool","sent_by_user":null,"line":null,"from_line":"771","our_number":"+61489267771","provider_source":"app","provider_status":null,"attachments":{"count":0,"types":[]},"event_at_source":"provider"},"metadata":{"capture_mode":"live"}}'::jsonb),
 ('r2','{"event_type":"client.sms_out","source":"ghl-webhook-receiver","entity_type":"contact","entity_id":"lYPee0K2DuQHXH2xHL1P","contact_id":"lYPee0K2DuQHXH2xHL1P","job_id":null,"match_method":"none","event_at":"2026-09-23T05:19:00.000Z","provider_message_id":"ghl:unJUR0MY5jwawuYXWYgR","channel":"sms","direction":"outbound","thread_key":null,"conversation_key":"I98nlO8dKPOAaylh7k23","body_preview":"Staff reply text for the R2 fixture.","safe_summary":"Staff reply text for the R2 fixture.","privacy_classification":"staff_only","retention_class":"7y_audit","payload":{"body":"Staff reply text for the R2 fixture.","text":"Staff reply text for the R2 fixture.","message":"Staff reply text for the R2 fixture.","message_text":"Staff reply text for the R2 fixture.","channel":"sms","direction":"outbound","ghl_message_id":"unJUR0MY5jwawuYXWYgR","ghl_contact_id":"lYPee0K2DuQHXH2xHL1P","ghl_message_type":"TYPE_SMS","conversation_key":"I98nlO8dKPOAaylh7k23","conversation_id":"I98nlO8dKPOAaylh7k23","sent_by_kind":"staff_app","sent_by_user":"RgDWTnYL6zL3eJA6nLht","line":"fencing","from_line":"772","our_number":"+61489267772","provider_source":"app","provider_status":"delivered","attachments":{"count":0,"types":[]},"event_at_source":"provider"},"metadata":{"capture_mode":"live"}}'::jsonb),
 ('r13','{"event_type":"client.reply","source":"ghl-webhook-receiver","entity_type":"contact","entity_id":"lYPee0K2DuQHXH2xHL1P","contact_id":"lYPee0K2DuQHXH2xHL1P","job_id":null,"match_method":"none","event_at":"2026-09-21T03:51:00.000Z","provider_message_id":"ghl:EofbCakVE65xUwRRuFwz","channel":"sms","direction":"inbound","thread_key":null,"conversation_key":"I98nlO8dKPOAaylh7k23","body_preview":"I only see one price of $5,478","safe_summary":"I only see one price of $5,478","privacy_classification":"staff_only","retention_class":"7y_audit","payload":{"body":"I only see one price of $5,478","text":"I only see one price of $5,478","message":"I only see one price of $5,478","message_text":"I only see one price of $5,478","channel":"sms","direction":"inbound","ghl_message_id":"EofbCakVE65xUwRRuFwz","ghl_contact_id":"lYPee0K2DuQHXH2xHL1P","ghl_message_type":"TYPE_SMS","conversation_key":"I98nlO8dKPOAaylh7k23","conversation_id":"I98nlO8dKPOAaylh7k23","sent_by_kind":"customer","sent_by_user":null,"line":"fencing","from_line":"772","our_number":"+61489267772","provider_source":null,"provider_status":null,"attachments":{"count":0,"types":[]},"event_at_source":"provider"},"metadata":{"capture_mode":"live"}}'::jsonb),
 ('r7','{"event_type":"ghl.internal_comment","source":"ghl-webhook-receiver","entity_type":"contact","entity_id":"1VHBzZX6DsjMZW2WbgQn","contact_id":"1VHBzZX6DsjMZW2WbgQn","job_id":null,"match_method":"none","event_at":"2026-09-08T02:00:00.000Z","provider_message_id":"ghl:kRoIUHpu59P3Bpx3FBv5","channel":"note","direction":"internal","thread_key":null,"conversation_key":"r5-conversation-placeholder","body_preview":"Internal comment for the R7 fixture: quote mistake.","safe_summary":"Internal comment for the R7 fixture: quote mistake.","privacy_classification":"staff_only","retention_class":"7y_audit","payload":{"body":"Internal comment for the R7 fixture: quote mistake.","text":"Internal comment for the R7 fixture: quote mistake.","message":"Internal comment for the R7 fixture: quote mistake.","message_text":"Internal comment for the R7 fixture: quote mistake.","channel":"note","direction":"internal","ghl_message_id":"kRoIUHpu59P3Bpx3FBv5","ghl_contact_id":"1VHBzZX6DsjMZW2WbgQn","ghl_message_type":"TYPE_INTERNAL_COMMENT","conversation_key":"r5-conversation-placeholder","conversation_id":"r5-conversation-placeholder","sent_by_kind":"staff_app","sent_by_user":"47AptTIxjOPutvcl6RpO","line":null,"from_line":null,"our_number":null,"provider_source":null,"provider_status":null,"attachments":{"count":0,"types":[]},"event_at_source":"provider"},"metadata":{"capture_mode":"live"}}'::jsonb),
 ('r32_mms','{"event_type":"client.reply","source":"ghl-webhook-receiver","entity_type":"contact","entity_id":"r32-contact-placeholder","contact_id":"r32-contact-placeholder","job_id":null,"match_method":"none","event_at":"2026-09-20T01:00:00.000Z","provider_message_id":"ghl:r32MmsPlaceholder01","channel":"sms","direction":"inbound","thread_key":null,"conversation_key":"r32-conversation-placeholder","body_preview":"[No text. 2 attachments: jpg, heic.]","safe_summary":"[No text. 2 attachments: jpg, heic.]","privacy_classification":"staff_only","retention_class":"7y_audit","payload":{"described_by_capture":true,"channel":"sms","direction":"inbound","ghl_message_id":"r32MmsPlaceholder01","ghl_contact_id":"r32-contact-placeholder","ghl_message_type":"TYPE_SMS","conversation_key":"r32-conversation-placeholder","conversation_id":"r32-conversation-placeholder","sent_by_kind":"customer","sent_by_user":null,"line":"fencing","from_line":"772","our_number":"+61489267772","provider_source":null,"provider_status":null,"attachments":{"count":2,"types":["jpg","heic"]},"event_at_source":"provider"},"metadata":{"capture_mode":"live"}}'::jsonb);
-- ROWS END

-- 1. Access: service_role only, SECURITY DEFINER, fixed search_path.
DO $$
DECLARE f regprocedure:='public.capture_business_event(jsonb)'::regprocedure;
BEGIN
 IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') OR has_function_privilege('public',f,'EXECUTE')
 THEN RAISE EXCEPTION 'c1a: anon, authenticated or PUBLIC may execute capture_business_event'; END IF;
 IF NOT has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'c1a: service_role cannot execute capture_business_event'; END IF;
 IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=f) THEN RAISE EXCEPTION 'c1a: capture_business_event is not SECURITY DEFINER'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=f AND 'search_path=public, pg_temp'=ANY(proconfig)) THEN RAISE EXCEPTION 'c1a: capture_business_event has no fixed search_path'; END IF;
END $$;
SAVEPOINT as_anon;
SET LOCAL ROLE anon;
DO $$
BEGIN
 PERFORM public.capture_business_event('{}'::jsonb);
 RAISE EXCEPTION 'c1a: anon called capture_business_event';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
ROLLBACK TO SAVEPOINT as_anon;
SAVEPOINT as_service;
SET LOCAL ROLE service_role;
DO $$
BEGIN
 IF public.capture_business_event('[]'::jsonb)->>'code' IS DISTINCT FROM 'capture_row_invalid' THEN
  RAISE EXCEPTION 'c1a: service_role call did not reach the writer'; END IF;
END $$;
ROLLBACK TO SAVEPOINT as_service;

-- 2. Behaviour.
DO $$
DECLARE
 org uuid:='00000000-0000-0000-0000-000000000001';
 r5_job uuid:='33333333-3333-4333-8333-333333333335';
 r1_a uuid:=gen_random_uuid(); r1_b uuid:=gen_random_uuid(); stranger uuid:=gen_random_uuid(); two_a uuid:=gen_random_uuid(); two_b uuid:=gen_random_uuid();
 tool jsonb; hook jsonb; out jsonb; e public.business_events; before public.business_events; n int; total int; t_start timestamptz:=clock_timestamp();
BEGIN
 SELECT r INTO tool FROM c1a_rows WHERE label='r5_tool';
 SELECT r INTO hook FROM c1a_rows WHERE label='r5_webhook';
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,metadata) VALUES
  (r5_job,org,'accepted','fencing','C1A-261335','1VHBzZX6DsjMZW2WbgQn','{}'),
  (r1_a,org,'quoted','fencing','C1A-261448','lYPee0K2DuQHXH2xHL1P','{}'),
  (r1_b,org,'quoted','fencing','C1A-261431','lYPee0K2DuQHXH2xHL1P','{}'),
  (stranger,org,'accepted','fencing','C1A-STRANGER','c1a-other-contact','{}'),
  (two_a,org,'quoted','fencing','C1A-TWO-A','c1a-two-jobs-contact','{}'),
  (two_b,org,'quoted','patio','C1A-TWO-B','c1a-two-jobs-contact','{}');

 -- R5, the webhook wins the race: the row is placed by the ladder (the
 -- contact's one open job), never direct, keyed ghl:<id>, no thread binding.
 out:=public.capture_business_event(hook);
 IF out->>'outcome'<>'inserted' OR out->>'attribution_status'<>'single_open' OR (out->>'job_id')::uuid<>r5_job THEN
  RAISE EXCEPTION 'c1a R5 webhook first: expected inserted single_open on the job, got %',out; END IF;
 SELECT * INTO before FROM public.business_events WHERE provider_message_id='ghl:mDS89hMzWE2R3VCMqxP2';
 IF before.id::text<>out->>'id' OR before.event_at<>'2026-09-18T01:10:00Z' OR before.thread_key IS NOT NULL
  OR before.conversation_key<>'r5-conversation-placeholder' OR before.context_captured_at IS NULL
  OR before.sequence_number IS NULL OR before.metadata->>'capture_mode'<>'live' THEN
  RAISE EXCEPTION 'c1a R5 webhook first: stored row wrong: %',to_jsonb(before); END IF;
 -- occurred_at is ingestion time, stamped by the writer; event_at stays GHL's time.
 IF before.occurred_at<t_start OR before.occurred_at>clock_timestamp() THEN
  RAISE EXCEPTION 'c1a: occurred_at % is not the write time',before.occurred_at; END IF;
 IF EXISTS (SELECT 1 FROM public.event_threads WHERE thread_key='r5-conversation-placeholder') THEN
  RAISE EXCEPTION 'c1a: a GHL conversation was bound as a job thread'; END IF;

 -- The tool's own write arrives second: one row, link upgraded to direct.
 out:=public.capture_business_event(tool);
 IF out->>'outcome'<>'duplicate' OR (out->>'upgraded')::boolean IS NOT TRUE OR out->>'attribution_status'<>'direct'
  OR (out->>'job_id')::uuid<>r5_job OR out->>'id'<>before.id::text THEN
  RAISE EXCEPTION 'c1a R5 tool second: expected duplicate upgraded to direct, got %',out; END IF;
 SELECT count(*) INTO n FROM public.business_events WHERE provider_message_id='ghl:mDS89hMzWE2R3VCMqxP2';
 IF n<>1 THEN RAISE EXCEPTION 'c1a R5: % rows for one message',n; END IF;
 SELECT * INTO e FROM public.business_events WHERE id=before.id;
 IF e.attribution_status<>'direct' OR e.attribution_step<>1 OR e.job_id<>r5_job OR e.attribution_confidence<>1 OR e.attributed_at IS NULL
  OR e.match_status<>'matched' OR e.match_method<>'direct_job_id' OR e.match_confidence<>1 THEN
  RAISE EXCEPTION 'c1a R5 upgrade: link fields wrong: %',to_jsonb(e); END IF;
 IF e.metadata->'upgraded_from'->>'attribution_status'<>'single_open' OR (e.metadata->'upgraded_from'->>'attribution_step')::int<>3
  OR e.metadata->'upgraded_from'->>'match_method'<>'contact_id' OR (e.metadata->'upgraded_from'->>'job_id')::uuid<>r5_job
  OR e.metadata->'upgraded_from'->>'upgraded_by_source'<>'ghl-proxy'
  OR e.metadata->'source_job_binding'<>jsonb_build_object('job_id',r5_job,'match_method','direct_job_id')
  OR e.metadata->>'capture_mode'<>'live' THEN
  RAISE EXCEPTION 'c1a R5 upgrade: metadata wrong: %',e.metadata; END IF;
 -- Nothing else on the existing row is overwritten.
 IF e.source<>'ghl-webhook-receiver' OR e.payload<>before.payload OR e.body_hash IS NOT NULL OR e.event_at<>before.event_at
  OR e.occurred_at<>before.occurred_at OR e.body_preview<>before.body_preview OR e.context_captured_at<>before.context_captured_at
  OR e.sequence_number<>before.sequence_number OR e.contact_id<>before.contact_id THEN
  RAISE EXCEPTION 'c1a R5 upgrade overwrote more than the link: before % after %',to_jsonb(before),to_jsonb(e); END IF;
 -- Replays (GHL retries up to 12 times; the tool may retry) change nothing.
 out:=public.capture_business_event(tool);
 IF out->>'outcome'<>'duplicate' OR (out->>'upgraded')::boolean OR out->>'attribution_status'<>'direct' THEN RAISE EXCEPTION 'c1a R5 tool replay: %',out; END IF;
 out:=public.capture_business_event(hook);
 IF out->>'outcome'<>'duplicate' OR (out->>'upgraded')::boolean OR out->>'attribution_status'<>'direct' OR (out->>'job_id')::uuid<>r5_job THEN
  RAISE EXCEPTION 'c1a R5 webhook replay moved the direct row: %',out; END IF;

 -- R5 shape, contact with two open jobs: the webhook row goes to review, and the
 -- tool's verified job then places it directly on the job it named.
 out:=public.capture_business_event(hook||jsonb_build_object('provider_message_id','ghl:c1aTwoJobsRace1','contact_id','c1a-two-jobs-contact','entity_id','c1a-two-jobs-contact'));
 IF out->>'attribution_status'<>'pending_luna' OR out->>'job_id' IS NOT NULL THEN RAISE EXCEPTION 'c1a two jobs webhook first: %',out; END IF;
 out:=public.capture_business_event(tool||jsonb_build_object('provider_message_id','ghl:c1aTwoJobsRace1','contact_id','c1a-two-jobs-contact','entity_id','c1a-two-jobs-contact','job_id',two_b));
 IF out->>'outcome'<>'duplicate' OR NOT (out->>'upgraded')::boolean OR (out->>'job_id')::uuid<>two_b THEN RAISE EXCEPTION 'c1a two jobs upgrade: %',out; END IF;
 SELECT * INTO e FROM public.business_events WHERE provider_message_id='ghl:c1aTwoJobsRace1';
 IF e.metadata->'upgraded_from'->>'attribution_status'<>'pending_luna' OR e.metadata->'upgraded_from'->'job_id'<>'null'::jsonb THEN
  RAISE EXCEPTION 'c1a two jobs upgrade: upgraded_from wrong %',e.metadata; END IF;

 -- R5, the tool wins the race: inserted direct by its verified writer job id;
 -- the webhook then lands as a duplicate and never changes the direct row.
 out:=public.capture_business_event(tool||'{"provider_message_id":"ghl:c1aToolFirst01"}');
 IF out->>'outcome'<>'inserted' OR out->>'attribution_status'<>'direct' OR (out->>'job_id')::uuid<>r5_job THEN RAISE EXCEPTION 'c1a tool first: %',out; END IF;
 SELECT * INTO before FROM public.business_events WHERE provider_message_id='ghl:c1aToolFirst01';
 IF before.body_hash<>'sha256-r5' OR before.event_at IS NOT NULL OR before.metadata->'source_job_binding'->>'match_method'<>'direct_job_id' THEN
  RAISE EXCEPTION 'c1a tool first: stored row wrong %',to_jsonb(before); END IF;
 out:=public.capture_business_event(hook||'{"provider_message_id":"ghl:c1aToolFirst01"}');
 IF out->>'outcome'<>'duplicate' OR (out->>'upgraded')::boolean OR (out->>'job_id')::uuid<>r5_job OR out->>'attribution_status'<>'direct' THEN
  RAISE EXCEPTION 'c1a tool first, webhook second: %',out; END IF;
 SELECT * INTO e FROM public.business_events WHERE provider_message_id='ghl:c1aToolFirst01';
 IF to_jsonb(e)<>to_jsonb(before) THEN RAISE EXCEPTION 'c1a tool first: the webhook duplicate changed the row'; END IF;

 -- A direct row is never moved by a later claim to another job.
 out:=public.capture_business_event(tool||jsonb_build_object('provider_message_id','ghl:c1aToolFirst01','job_id',stranger));
 IF out->>'outcome'<>'duplicate' OR (out->>'upgraded')::boolean OR NOT (out->>'direct_job_mismatch')::boolean OR (out->>'job_id')::uuid<>r5_job THEN
  RAISE EXCEPTION 'c1a direct row moved or mismatch not reported: %',out; END IF;
 IF (SELECT job_id FROM public.business_events WHERE provider_message_id='ghl:c1aToolFirst01')<>r5_job THEN RAISE EXCEPTION 'c1a direct row moved'; END IF;

 -- A job id that does not exist never upgrades anything.
 PERFORM public.capture_business_event(hook||'{"provider_message_id":"ghl:c1aNoSuchJob01"}');
 out:=public.capture_business_event(tool||'{"provider_message_id":"ghl:c1aNoSuchJob01","job_id":"44444444-4444-4444-8444-444444444444"}');
 IF (out->>'upgraded')::boolean OR out->>'attribution_status'<>'single_open' THEN RAISE EXCEPTION 'c1a nonexistent job upgraded: %',out; END IF;

 -- Attribution lane off: like the ladder, the writer places nothing.
 UPDATE public.automation_switches SET attribution=false WHERE id=1;
 out:=public.capture_business_event(hook||'{"provider_message_id":"ghl:c1aAttrOff001"}');
 IF out->>'outcome'<>'inserted' OR out->>'job_id' IS NOT NULL THEN RAISE EXCEPTION 'c1a attribution off insert: %',out; END IF;
 out:=public.capture_business_event(tool||'{"provider_message_id":"ghl:c1aAttrOff001"}');
 IF (out->>'upgraded')::boolean OR out->>'upgrade_skipped'<>'attribution_disabled' OR out->>'job_id' IS NOT NULL THEN
  RAISE EXCEPTION 'c1a attribution off upgraded: %',out; END IF;
 UPDATE public.automation_switches SET attribution=true WHERE id=1;

 -- Capture lane off: nothing written, outcome capture_disabled.
 SELECT count(*) INTO total FROM public.business_events;
 UPDATE public.automation_switches SET capture=false WHERE id=1;
 out:=public.capture_business_event(tool||'{"provider_message_id":"ghl:c1aCaptureOff1"}');
 IF out<>'{"outcome":"capture_disabled"}'::jsonb THEN RAISE EXCEPTION 'c1a capture off: %',out; END IF;
 UPDATE public.automation_switches SET capture=true WHERE id=1;
 IF (SELECT count(*) FROM public.business_events)<>total THEN RAISE EXCEPTION 'c1a capture off wrote a row'; END IF;

 -- R2: staff reply from the app; the R1 contact has two open quotes, so it
 -- goes to review, never a guess, and never direct.
 out:=public.capture_business_event((SELECT r FROM c1a_rows WHERE label='r2'));
 IF out->>'outcome'<>'inserted' OR out->>'attribution_status'<>'pending_luna' OR out->>'job_id' IS NOT NULL THEN RAISE EXCEPTION 'c1a R2: %',out; END IF;
 SELECT * INTO e FROM public.business_events WHERE provider_message_id='ghl:unJUR0MY5jwawuYXWYgR';
 IF e.channel<>'sms' OR e.direction<>'outbound' OR e.payload->>'sent_by_kind'<>'staff_app' OR e.payload->>'line'<>'fencing' THEN
  RAISE EXCEPTION 'c1a R2 stored: %',to_jsonb(e); END IF;

 -- R13: "$5,478" never links directly (step 1 is our references only).
 out:=public.capture_business_event((SELECT r FROM c1a_rows WHERE label='r13'));
 IF out->>'outcome'<>'inserted' OR out->>'attribution_status'='direct' OR out->>'attribution_status'<>'pending_luna' THEN RAISE EXCEPTION 'c1a R13: %',out; END IF;

 -- R7: an internal comment passes the live channel and direction checks
 -- (note / internal) and is placed on the contact's one job like any row.
 out:=public.capture_business_event((SELECT r FROM c1a_rows WHERE label='r7'));
 IF out->>'outcome'<>'inserted' OR out->>'attribution_status'<>'single_open' OR (out->>'job_id')::uuid<>r5_job THEN RAISE EXCEPTION 'c1a R7: %',out; END IF;
 IF (SELECT channel||'/'||direction FROM public.business_events WHERE provider_message_id='ghl:kRoIUHpu59P3Bpx3FBv5')<>'note/internal' THEN
  RAISE EXCEPTION 'c1a R7 stored channel/direction wrong'; END IF;

 -- R32 MMS with no words: the description is readable text, so it is not "empty".
 out:=public.capture_business_event((SELECT r FROM c1a_rows WHERE label='r32_mms'));
 IF out->>'outcome'<>'inserted' OR out->>'attribution_status'='empty' THEN RAISE EXCEPTION 'c1a R32 MMS: %',out; END IF;

 -- An unconfirmed job id is only a hint: the ladder records it and places by its own rules.
 out:=public.capture_business_event(hook||jsonb_build_object('provider_message_id','ghl:c1aHintOnly01','job_id',stranger));
 SELECT * INTO e FROM public.business_events WHERE provider_message_id='ghl:c1aHintOnly01';
 IF e.job_id IS DISTINCT FROM r5_job OR e.attribution_status<>'single_open' OR (e.metadata->'attribution_hint'->>'job_id')::uuid<>stranger THEN
  RAISE EXCEPTION 'c1a hint only: %',to_jsonb(e); END IF;

 -- Refusals write nothing and carry a code, never row text.
 SELECT count(*) INTO total FROM public.business_events;
 IF public.capture_business_event(NULL)->>'code'<>'capture_row_invalid' THEN RAISE EXCEPTION 'c1a null row'; END IF;
 IF public.capture_business_event('[1]')->>'code'<>'capture_row_invalid' THEN RAISE EXCEPTION 'c1a array row'; END IF;
 IF public.capture_business_event(tool-'provider_message_id')->>'code'<>'capture_row_key_required' THEN RAISE EXCEPTION 'c1a no key'; END IF;
 IF public.capture_business_event(tool||'{"provider_message_id":"  "}')->>'code'<>'capture_row_key_required' THEN RAISE EXCEPTION 'c1a blank key'; END IF;
 IF public.capture_business_event(tool-'event_type')->>'code'<>'capture_row_event_type_required' THEN RAISE EXCEPTION 'c1a no event_type'; END IF;
 IF public.capture_business_event(tool-'source')->>'code'<>'capture_row_source_required' THEN RAISE EXCEPTION 'c1a no source'; END IF;
 IF public.capture_business_event(tool-'metadata')->>'code'<>'capture_row_capture_mode_invalid' THEN RAISE EXCEPTION 'c1a no metadata'; END IF;
 IF public.capture_business_event(tool||'{"metadata":{"capture_mode":"sometimes"}}')->>'code'<>'capture_row_capture_mode_invalid' THEN RAISE EXCEPTION 'c1a bad mode'; END IF;
 IF public.capture_business_event(tool||'{"metadata":"live"}')->>'code'<>'capture_row_capture_mode_invalid' THEN RAISE EXCEPTION 'c1a metadata not object'; END IF;
 out:=public.capture_business_event(tool||'{"provider_message_id":"ghl:c1aRefuse0001","occurred_at":"2026-01-01T00:00:00Z","attribution_status":"direct","id":"55555555-5555-4555-8555-555555555555"}');
 IF out<>'{"outcome":"error","code":"capture_row_writer_owned_field","fields":["attribution_status","id","occurred_at"]}'::jsonb THEN RAISE EXCEPTION 'c1a writer owned: %',out; END IF;
 out:=public.capture_business_event(tool||'{"provider_message_id":"ghl:c1aRefuse0002","bogus_col":1}');
 IF out<>'{"outcome":"error","code":"capture_row_unknown_column","fields":["bogus_col"]}'::jsonb THEN RAISE EXCEPTION 'c1a unknown column: %',out; END IF;
 -- Database refusals come back as a code: the live channel check, a bad time.
 out:=public.capture_business_event(tool||'{"provider_message_id":"ghl:c1aRefuse0003","channel":"calendar"}');
 IF out<>'{"outcome":"error","code":"23514"}'::jsonb THEN RAISE EXCEPTION 'c1a channel check: %',out; END IF;
 out:=public.capture_business_event(tool||'{"provider_message_id":"ghl:c1aRefuse0004","event_at":"not a time"}');
 IF out->>'outcome'<>'error' OR out->>'code' !~ '^22' OR out::text LIKE '%not a time%' THEN RAISE EXCEPTION 'c1a bad time: %',out; END IF;
 IF (SELECT count(*) FROM public.business_events)<>total THEN RAISE EXCEPTION 'c1a a refusal wrote a row'; END IF;
END $$;
ROLLBACK;
