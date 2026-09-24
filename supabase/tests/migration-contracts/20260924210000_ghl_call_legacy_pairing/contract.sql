BEGIN;
DO $$
DECLARE
 org uuid:='00000000-0000-0000-0000-000000000001';
 contact text:='t1-one-contact'; other_contact text:='t1-other-contact';
 j uuid:=gen_random_uuid(); at_time timestamptz:='2026-09-24T04:00:00Z';
 legacy_one uuid; legacy_outside uuid; legacy_other uuid; legacy_many_a uuid; legacy_many_b uuid;
 before_one jsonb; out jsonb; logged_id uuid; pair_count integer;
BEGIN
 UPDATE public.automation_switches SET capture=true,all_stop=false WHERE id=1;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,metadata)
 VALUES(j,org,'quoted','fencing','T1-PAIR-'||left(j::text,8),contact,'{}');

 INSERT INTO public.business_events(event_type,source,contact_id,job_id,match_method,direction,channel,event_at,occurred_at,payload)
 VALUES('client.call_complete','ghl-webhook-receiver',contact,j,'direct_job_id','inbound','call',at_time+interval '120 seconds',at_time+interval '120 seconds','{"body":"legacy one"}')
 RETURNING id INTO legacy_one;
 before_one:=(SELECT to_jsonb(e) FROM public.business_events e WHERE e.id=legacy_one);
 INSERT INTO public.business_events(event_type,source,contact_id,direction,channel,event_at,occurred_at,payload)
 VALUES('client.call_complete','ghl-webhook-receiver',contact,'inbound','call',at_time-interval '121 seconds',at_time-interval '121 seconds','{"body":"outside window"}')
 RETURNING id INTO legacy_outside;
 INSERT INTO public.business_events(event_type,source,contact_id,direction,channel,event_at,occurred_at,payload)
 VALUES('client.call_complete','ghl-webhook-receiver',other_contact,'inbound','call',at_time,at_time,'{"body":"other contact"}')
 RETURNING id INTO legacy_other;

 out:=public.capture_business_event(jsonb_build_object(
  'event_type','client.call_logged','source','ghl-webhook-receiver','entity_type','contact','entity_id',contact,
  'contact_id',contact,'job_id',j,'match_method','direct_job_id','event_at',at_time,'provider_message_id','ghl:t1-pair-one',
  'channel','call','direction','inbound','body_preview','[Call, inbound.]','payload',jsonb_build_object('body_preview','[Call, inbound.]','legacy_event_id','caller-forged'),
  'metadata',jsonb_build_object('capture_mode','live')));
 IF out->>'outcome'<>'inserted' THEN RAISE EXCEPTION 'exactly-one call did not insert: %',out; END IF;
 logged_id:=(out->>'id')::uuid;
 IF (SELECT payload->>'legacy_event_id' FROM public.business_events WHERE id=logged_id) IS DISTINCT FROM legacy_one::text
 THEN RAISE EXCEPTION 'exactly-one match was not linked'; END IF;
 IF (SELECT to_jsonb(e) FROM public.business_events e WHERE e.id=legacy_one) IS DISTINCT FROM before_one
 THEN RAISE EXCEPTION 'pairing edited the legacy event'; END IF;
 IF (SELECT payload ? 'legacy_event_id' FROM public.business_events WHERE provider_message_id='ghl:t1-pair-one') IS NOT TRUE
 THEN RAISE EXCEPTION 'legacy id missing from call payload'; END IF;
 SELECT count(*) INTO pair_count FROM public.context_unread_rows(ARRAY[j]) WHERE id IN (legacy_one,logged_id);
 IF pair_count<>1 OR NOT EXISTS(SELECT 1 FROM public.context_unread_rows(ARRAY[j]) WHERE id=logged_id)
 THEN RAISE EXCEPTION 'context extraction did not retain only the call row'; END IF;

 out:=public.capture_business_event(jsonb_build_object(
  'event_type','client.call_logged','source','ghl-webhook-receiver','entity_type','contact','entity_id',contact,
  'contact_id',contact,'job_id',j,'match_method','direct_job_id','event_at',at_time,'provider_message_id','ghl:t1-pair-next',
  'channel','call','direction','inbound','body_preview','[Call, inbound.]','payload',jsonb_build_object('body_preview','[Call, inbound.]','legacy_event_id','caller-forged'),
  'metadata',jsonb_build_object('capture_mode','live')));
 IF (SELECT payload ? 'legacy_event_id' FROM public.business_events WHERE id=(out->>'id')::uuid) IS TRUE
 THEN RAISE EXCEPTION 'one legacy call was paired more than once'; END IF;

 out:=public.capture_business_event(jsonb_build_object(
  'event_type','client.call_logged','source','ghl-webhook-receiver','entity_type','contact','entity_id','t1-none-contact',
  'contact_id','t1-none-contact','event_at',at_time,'provider_message_id','ghl:t1-pair-none','channel','call','direction','inbound',
  'body_preview','[Call, inbound.]','payload',jsonb_build_object('body_preview','[Call, inbound.]','legacy_event_id','caller-forged'),
  'metadata',jsonb_build_object('capture_mode','live')));
 IF out->>'outcome'<>'inserted' OR (SELECT payload ? 'legacy_event_id' FROM public.business_events WHERE id=(out->>'id')::uuid) IS TRUE
 THEN RAISE EXCEPTION 'no-match call was not saved independently: %',out; END IF;

 INSERT INTO public.business_events(event_type,source,contact_id,direction,channel,event_at,occurred_at,payload)
 VALUES('client.call_complete','ghl-webhook-receiver','t1-many-contact','inbound','call',at_time,at_time,'{"body":"legacy many a"}') RETURNING id INTO legacy_many_a;
 INSERT INTO public.business_events(event_type,source,contact_id,direction,channel,event_at,occurred_at,payload)
 VALUES('client.call_complete','ghl-webhook-receiver','t1-many-contact','inbound','call',at_time+interval '30 seconds',at_time+interval '30 seconds','{"body":"legacy many b"}') RETURNING id INTO legacy_many_b;
 out:=public.capture_business_event(jsonb_build_object(
  'event_type','client.call_logged','source','ghl-webhook-receiver','entity_type','contact','entity_id','t1-many-contact',
  'contact_id','t1-many-contact','event_at',at_time,'provider_message_id','ghl:t1-pair-many','channel','call','direction','inbound',
  'body_preview','[Call, inbound.]','payload',jsonb_build_object('body_preview','[Call, inbound.]','legacy_event_id','caller-forged'),
  'metadata',jsonb_build_object('capture_mode','live')));
 IF out->>'outcome'<>'inserted' OR (SELECT payload ? 'legacy_event_id' FROM public.business_events WHERE id=(out->>'id')::uuid) IS TRUE
 THEN RAISE EXCEPTION 'ambiguous call match must insert without pairing: %',out; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.business_events WHERE id=legacy_outside)
  OR NOT EXISTS(SELECT 1 FROM public.business_events WHERE id=legacy_other)
  OR NOT EXISTS(SELECT 1 FROM public.business_events WHERE id=legacy_many_a)
  OR NOT EXISTS(SELECT 1 FROM public.business_events WHERE id=legacy_many_b)
 THEN RAISE EXCEPTION 'pairing removed a legacy event'; END IF;
END $$;
ROLLBACK;
