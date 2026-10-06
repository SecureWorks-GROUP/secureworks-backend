-- Capture copies contract (20261006031000). Every fixture write is rolled
-- back. Ids, job numbers, contacts and text are synthetic.

-- A job and a placed, admissible message row on it (through the real ladder).
CREATE FUNCTION pg_temp.cc_job(p_number text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,metadata,created_at)
  VALUES(j,'00000000-0000-0000-0000-000000000001','scheduled','fencing',p_number,'{}',now()-interval '30 days');
 RETURN j;
END $$;
CREATE FUNCTION pg_temp.cc_placed(p_job uuid,p_body text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE new_id uuid;
BEGIN
 INSERT INTO public.business_events(job_id,match_method,direction,channel,event_type,source,payload,occurred_at,event_at)
  VALUES(p_job,'direct_job_id','inbound','sms','client.sms_in','copies_contract',jsonb_build_object('body',p_body),
   now()-interval '2 hours',now()-interval '2 hours')
  RETURNING id INTO new_id;
 UPDATE public.business_events SET context_captured_at=now()-interval '2 hours' WHERE id=new_id;
 RETURN new_id;
END $$;
-- An older writer's row with no ghl: key (as ghl-proxy and the ops-api
-- backfill saved them before keying). p_gid goes in payload.ghl_message_id,
-- p_mid in payload.message_id; either may be null. Written as stored (no
-- trigger), so each placement and read state can be set exactly: by default
-- placed direct on a job of its own, captured, written as service_role, so
-- the readers read it. p_status admin_bucket or null puts it on no job.
CREATE FUNCTION pg_temp.cc_legacy(p_contact text,p_dir text,p_body text,p_at timestamptz,p_gid text,p_mid text DEFAULT NULL,
 p_source text DEFAULT 'ghl-proxy',p_status text DEFAULT 'direct',p_channel text DEFAULT 'sms',p_meta jsonb DEFAULT '{}',
 p_captured boolean DEFAULT true) RETURNS uuid LANGUAGE plpgsql SET session_replication_role=replica AS $$
DECLARE new_id uuid:=gen_random_uuid(); j uuid; placed boolean:=coalesce(public.context_linked_status(p_status),false);
BEGIN
 IF placed THEN j:=pg_temp.cc_job('CC-L-'||left(new_id::text,8)); END IF;
 INSERT INTO public.business_events(id,job_id,event_type,source,entity_type,entity_id,contact_id,direction,channel,payload,metadata,
  occurred_at,event_at,recorded_at,context_captured_at,attribution_status,attribution_step,attribution_confidence,attributed_at,match_method)
  VALUES(new_id,j,CASE p_dir WHEN 'inbound' THEN 'client.reply' ELSE 'client.sms_out' END,p_source,'contact',p_contact,p_contact,p_dir,p_channel,
   jsonb_strip_nulls(jsonb_build_object('body',p_body,'ghl_message_id',p_gid,'message_id',p_mid,'ghl_contact_id',p_contact)),
   jsonb_build_object('written_as','service_role')||p_meta,p_at,p_at,p_at,CASE WHEN p_captured THEN p_at END,
   p_status,CASE WHEN placed THEN 1 END,CASE WHEN placed THEN 1 END,CASE WHEN placed THEN p_at END,
   CASE WHEN placed THEN 'direct_job_id' ELSE 'none' END);
 RETURN new_id;
END $$;
-- A history row as _shared/evidence/ghl_message.ts builds it. p_body null is
-- a bracketed word-less row (described_by_capture).
CREATE FUNCTION pg_temp.cc_row(p_id text,p_contact text,p_dir text,p_body text,p_at text,p_read text DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object(
  'event_type',CASE p_dir WHEN 'inbound' THEN 'client.reply' ELSE 'client.sms_out' END,
  'source','ghl-history-load','entity_type','contact','entity_id',p_contact,'contact_id',p_contact,
  'job_id',NULL,'match_method','none','event_at',p_at,'provider_message_id','ghl:'||p_id,
  'channel','sms','direction',p_dir,'thread_key',NULL,
  'body_preview',coalesce(p_body,p_read),'safe_summary',coalesce(p_body,p_read),'privacy_classification','staff_only','retention_class','7y_audit',
  'payload',CASE WHEN p_body IS NULL THEN jsonb_build_object('described_by_capture',true)
   ELSE jsonb_build_object('body',p_body,'text',p_body,'message',p_body) END
   ||jsonb_build_object('channel','sms','direction',p_dir,'ghl_message_id',p_id,'ghl_contact_id',p_contact),
  'metadata',jsonb_build_object('capture_mode','backfill','history_run_id','00000000-0000-4000-8000-00000000c0de'))
$$;

-- 1. Shape and grants. The admission rule stays invoker SQL with no SET
-- clause (context_unread_rows stays inlinable); the copies read and the door
-- are definers with a fixed search_path; all three are service role only.
DO $$
DECLARE f regprocedure;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_event_source_admissible(public.business_events)','public.context_ghl_message_copies(jsonb)',
  'public.capture_ghl_history_event(jsonb)','public.context_job_record_messages(uuid[],timestamptz)',
  'public.context_job_story_meta(uuid,timestamptz)']::regprocedure[] LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') OR has_function_privilege('public',f,'EXECUTE')
   OR NOT has_function_privilege('service_role',f,'EXECUTE')
  THEN RAISE EXCEPTION 'capture copies grants on %',f; END IF;
 END LOOP;
 IF (SELECT proconfig IS NOT NULL OR prosecdef OR prolang<>(SELECT oid FROM pg_language WHERE lanname='sql') FROM pg_proc
   WHERE oid='public.context_event_source_admissible(public.business_events)'::regprocedure)
 THEN RAISE EXCEPTION 'capture copies: the admission rule is not inlinable-shaped (invoker SQL, no SET)'; END IF;
 FOREACH f IN ARRAY ARRAY['public.context_ghl_message_copies(jsonb)','public.capture_ghl_history_event(jsonb)']::regprocedure[] LOOP
  IF (SELECT proconfig IS NULL OR NOT prosecdef FROM pg_proc WHERE oid=f) THEN RAISE EXCEPTION 'capture copies: % must be a definer with a fixed search_path',f; END IF;
 END LOOP;
 -- The record messages helper stays inlinable (invoker SQL, no SET); the story meta stays a definer.
 IF (SELECT proconfig IS NOT NULL OR prosecdef FROM pg_proc WHERE oid='public.context_job_record_messages(uuid[],timestamptz)'::regprocedure)
 THEN RAISE EXCEPTION 'capture copies: context_job_record_messages must stay invoker SQL with no SET'; END IF;
 IF (SELECT proconfig IS NULL OR NOT prosecdef FROM pg_proc WHERE oid='public.context_job_story_meta(uuid,timestamptz)'::regprocedure)
 THEN RAISE EXCEPTION 'capture copies: context_job_story_meta must stay a definer with a fixed search_path'; END IF;
 IF NOT public.automation_lane_enabled('capture') OR NOT public.automation_lane_enabled('attribution') OR NOT public.automation_lane_enabled('extraction')
 THEN RAISE EXCEPTION 'capture copies fixture: a lane is off'; END IF;
END $$;

-- 2. A marked copy is never read: not admissible, not unread, not in the
-- catch-up set, not handed out. Its original still is. A fact that already
-- cites the copy stays current (the current-facts view does not read the mark).
BEGIN;
DO $$
DECLARE j uuid:=pg_temp.cc_job('CC-ADM'); orig uuid; copy uuid; r public.business_events; fact uuid:=gen_random_uuid();
BEGIN
 orig:=pg_temp.cc_placed(j,'Copies contract original message.');
 copy:=pg_temp.cc_placed(j,'Copies contract original message.');
 SELECT * INTO r FROM public.business_events WHERE id=copy;
 IF NOT public.context_event_source_admissible(r) THEN RAISE EXCEPTION 'capture copies fixture: an unmarked placed row must be admissible, got %',r.attribution_status; END IF;
 INSERT INTO public.job_context(id,job_id,kind,value,provenance,lifecycle,source_event_ids,extractor_version,trust)
  VALUES(fact,j,'note','{"text":"Cites the copy."}','{"extractor":"luna_v2","writer_role":"classifier"}','current',ARRAY[copy],'luna_v2','luna');
 IF NOT EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE id=fact) THEN RAISE EXCEPTION 'capture copies fixture: the fact must be current before marking'; END IF;

 UPDATE public.business_events SET metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('duplicate_of',orig::text) WHERE id=copy;
 SELECT * INTO r FROM public.business_events WHERE id=copy;
 IF public.context_event_source_admissible(r) THEN RAISE EXCEPTION 'capture copies: a marked copy must not be admissible'; END IF;
 IF EXISTS(SELECT 1 FROM public.context_unread_rows(ARRAY[j]) u WHERE u.id=copy) THEN RAISE EXCEPTION 'capture copies: a marked copy must not be unread'; END IF;
 IF EXISTS(SELECT 1 FROM public.context_catchup_eligible_rows(ARRAY[j]) u WHERE u.id=copy) THEN RAISE EXCEPTION 'capture copies: a marked copy must not be in the catch-up set'; END IF;
 IF EXISTS(SELECT 1 FROM public.context_extraction_events(j,25) b WHERE b.id=copy) THEN RAISE EXCEPTION 'capture copies: a marked copy must not be handed out'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.context_unread_rows(ARRAY[j]) u WHERE u.id=orig) THEN RAISE EXCEPTION 'capture copies: the original must stay unread'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE id=fact) THEN RAISE EXCEPTION 'capture copies: a fact citing a marked copy must stay current'; END IF;
 -- The row stays where it was: same job, same placement.
 IF r.job_id IS DISTINCT FROM j OR NOT public.context_linked_status(r.attribution_status) THEN RAISE EXCEPTION 'capture copies: marking moved the row'; END IF;
 -- Removing the mark (the undo) makes it readable again.
 UPDATE public.business_events SET metadata=metadata-'duplicate_of' WHERE id=copy;
 SELECT * INTO r FROM public.business_events WHERE id=copy;
 IF NOT public.context_event_source_admissible(r) THEN RAISE EXCEPTION 'capture copies: an unmarked row must be admissible again'; END IF;
END $$;
ROLLBACK;

-- 3. The history door saves nothing for a message another writer already
-- saved, by GHL message id (payload.ghl_message_id or payload.message_id).
BEGIN;
DO $$
DECLARE c1 uuid; c2 uuid; o jsonb; n integer; t timestamptz:='2026-09-20T02:00:00Z';
BEGIN
 c1:=pg_temp.cc_legacy('CCcontact0000001','outbound','Proxy text saved before keying.',t,'CCgid00000000000001');
 o:=public.capture_ghl_history_event(pg_temp.cc_row('CCgid00000000000001','CCcontact0000001','outbound','Proxy text saved before keying.','2026-09-20T01:59:59Z'));
 SELECT count(*) INTO n FROM public.business_events WHERE provider_message_id='ghl:CCgid00000000000001';
 IF o->>'outcome' IS DISTINCT FROM 'duplicate' OR (o->>'copy_of_other_writer')::boolean IS NOT TRUE OR o->>'id'<>c1::text
  OR o->>'copy_rule'<>'ghl_message_id' OR o->>'stored_by'<>'ghl-proxy' OR (o->>'upgraded')::boolean OR n<>0
 THEN RAISE EXCEPTION 'C1: a message ghl-proxy already saved must not be saved again, got % n=%',o,n; END IF;
 -- payload.message_id (ghl-proxy's other key), from the ops-api backfill.
 c2:=pg_temp.cc_legacy('CCcontact0000001','inbound','Backfill reply.',t+interval '1 hour',NULL,'CCgid00000000000002','ops-api/backfill_ghl_conversations');
 o:=public.capture_ghl_history_event(pg_temp.cc_row('CCgid00000000000002','CCcontact0000001','inbound','Backfill reply, other words.','2026-09-20T05:00:00Z'));
 IF o->>'outcome' IS DISTINCT FROM 'duplicate' OR o->>'id'<>c2::text OR o->>'copy_rule'<>'ghl_message_id'
 THEN RAISE EXCEPTION 'C2: the same GHL id matches whatever its words or time, got %',o; END IF;
 -- The oldest of two older copies is named.
 PERFORM pg_temp.cc_legacy('CCcontact0000001','outbound','Two older copies.',t+interval '2 hours 1 second','CCgid00000000000003');
 c1:=pg_temp.cc_legacy('CCcontact0000001','outbound','Two older copies.',t+interval '2 hours','CCgid00000000000003',NULL,'ghl-webhook-receiver');
 o:=public.capture_ghl_history_event(pg_temp.cc_row('CCgid00000000000003','CCcontact0000001','outbound','Two older copies.','2026-09-20T04:00:00Z'));
 IF o->>'id'<>c1::text OR o->>'stored_by'<>'ghl-webhook-receiver' THEN RAISE EXCEPTION 'C3: the oldest copy must be named, got %',o; END IF;
END $$;
ROLLBACK;

-- 3b. An older row stands in only when the readers read it. A key-less row
-- that names the GHL id but is on no job, in admin_bucket, with no status,
-- with no channel, retracted, already marked as a copy, never captured, not
-- written as service_role, or without words, is not a copy: the keyed row is
-- saved (and placed by the ladder), so the message still reaches its job.
BEGIN;
DO $$
DECLARE o jsonb; n integer; x record; tw uuid; t timestamptz:='2026-09-20T08:00:00Z'; i integer:=0;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('admin_bucket on no job','admin_bucket','sms','{}'::jsonb,true,'Older text, admin bucket.'),
  ('no status on no job',NULL,'sms','{}'::jsonb,true,'Older text, no status.'),
  ('pending_luna on no job','pending_luna','sms','{}'::jsonb,true,'Older text, pending review.'),
  ('no channel','direct',NULL,'{}'::jsonb,true,'Older text, no channel.'),
  ('another channel','direct','email','{}'::jsonb,true,'Older text, other channel.'),
  ('retracted','direct','sms',jsonb_build_object('retracted_at','2026-09-25T00:00:00Z'),true,'Older text, retracted.'),
  ('already a copy','direct','sms',jsonb_build_object('duplicate_of',gen_random_uuid()::text),true,'Older text, a copy.'),
  ('never captured','direct','sms','{}'::jsonb,false,'Older text, not captured.'),
  ('written as authenticated','direct','sms',jsonb_build_object('written_as','authenticated'),true,'Older text, authenticated.'),
  ('no words','direct','sms','{}'::jsonb,true,NULL)
 ) AS v(label,status,channel,meta,captured,body) LOOP
  i:=i+1;
  PERFORM pg_temp.cc_legacy('CCcontact000005'||i,'inbound',x.body,t+make_interval(mins=>i),'CCgidStand'||lpad(i::text,9,'0'),NULL,
   'ghl_sms_cache_backfill',x.status,x.channel,x.meta,x.captured);
  o:=public.capture_ghl_history_event(pg_temp.cc_row('CCgidStand'||lpad(i::text,9,'0'),'CCcontact000005'||i,'inbound',
   'The real message '||i||'.',to_char((t+make_interval(mins=>i)) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')));
  SELECT count(*) INTO n FROM public.business_events WHERE provider_message_id='ghl:CCgidStand'||lpad(i::text,9,'0');
  IF o->>'outcome' IS DISTINCT FROM 'inserted' OR o ? 'copy_of_other_writer' OR n<>1 THEN
   RAISE EXCEPTION 'S%: an older row that is % must not stand in; the keyed row must be saved, got % n=%',i,x.label,o,n;
  END IF;
 END LOOP;
 -- The same rule on the words-and-time branch: an older key-less row with no
 -- GHL id, the same words 2 s apart, in admin_bucket on no job, is not a copy.
 PERFORM pg_temp.cc_legacy('CCcontact0000060','outbound','Same words, bucket.',t,NULL,NULL,'ghl-proxy','admin_bucket');
 o:=public.capture_ghl_history_event(pg_temp.cc_row('CCgidStand900000001','CCcontact0000060','outbound','Same words, bucket.','2026-09-20T08:00:02Z'));
 IF o->>'outcome' IS DISTINCT FROM 'inserted' THEN RAISE EXCEPTION 'S11: an unread same-words row must not stand in, got %',o; END IF;
 -- When an unread twin and a read twin both exist, the read one is named.
 PERFORM pg_temp.cc_legacy('CCcontact0000061','outbound','Two twins.',t,'CCgidStand900000002',NULL,'ghl_sms_cache_backfill','admin_bucket');
 tw:=pg_temp.cc_legacy('CCcontact0000061','outbound','Two twins.',t+interval '1 second','CCgidStand900000002');
 o:=public.capture_ghl_history_event(pg_temp.cc_row('CCgidStand900000002','CCcontact0000061','outbound','Two twins.','2026-09-20T08:00:00Z'));
 IF o->>'outcome' IS DISTINCT FROM 'duplicate' OR o->>'id'<>tw::text THEN RAISE EXCEPTION 'S12: the read twin must be named, got %',o; END IF;
END $$;
ROLLBACK;

-- 4. With no GHL id on the older row: the same contact, channel, direction
-- and words within 5 seconds is the same message; anything else is not.
BEGIN;
DO $$
DECLARE c1 uuid; o jsonb; n integer; t timestamptz:='2026-09-21T02:00:00Z';
BEGIN
 c1:=pg_temp.cc_legacy('CCcontact0000002','outbound','Hi, we are on our way.',t,NULL);
 o:=public.capture_ghl_history_event(pg_temp.cc_row('CCgid00000000000011','CCcontact0000002','outbound','Hi, we are on our way.','2026-09-21T02:00:03Z'));
 IF o->>'outcome' IS DISTINCT FROM 'duplicate' OR o->>'id'<>c1::text OR o->>'copy_rule'<>'same_words_and_time'
 THEN RAISE EXCEPTION 'W1: same words 3 s apart with no GHL id must be the same message, got %',o; END IF;
 -- 10 seconds apart: a different message.
 o:=public.capture_ghl_history_event(pg_temp.cc_row('CCgid00000000000012','CCcontact0000002','outbound','Hi, we are on our way.','2026-09-21T02:00:10Z'));
 IF o->>'outcome' IS DISTINCT FROM 'inserted' THEN RAISE EXCEPTION 'W2: 10 s apart must be saved, got %',o; END IF;
 -- Another contact, the other direction, other words: saved.
 o:=public.capture_ghl_history_event(pg_temp.cc_row('CCgid00000000000013','CCcontact0000003','outbound','Hi, we are on our way.','2026-09-21T02:00:01Z'));
 IF o->>'outcome' IS DISTINCT FROM 'inserted' THEN RAISE EXCEPTION 'W3: another contact must be saved, got %',o; END IF;
 o:=public.capture_ghl_history_event(pg_temp.cc_row('CCgid00000000000014','CCcontact0000002','inbound','Hi, we are on our way.','2026-09-21T02:00:01Z'));
 IF o->>'outcome' IS DISTINCT FROM 'inserted' THEN RAISE EXCEPTION 'W4: the other direction must be saved, got %',o; END IF;
 o:=public.capture_ghl_history_event(pg_temp.cc_row('CCgid00000000000015','CCcontact0000002','outbound','Hi, we are nearly there.','2026-09-21T02:00:01Z'));
 IF o->>'outcome' IS DISTINCT FROM 'inserted' THEN RAISE EXCEPTION 'W5: other words must be saved, got %',o; END IF;
 -- An older row that carries its own different GHL id is a different message
 -- (two texts with the same words, the live case of a repeated "Thank you").
 PERFORM pg_temp.cc_legacy('CCcontact0000004','inbound','Thank you',t,'CCgidOther000000001');
 o:=public.capture_ghl_history_event(pg_temp.cc_row('CCgid00000000000016','CCcontact0000004','inbound','Thank you','2026-09-21T02:00:00Z'));
 IF o->>'outcome' IS DISTINCT FROM 'inserted' THEN RAISE EXCEPTION 'W6: a different GHL id is a different message, got %',o; END IF;
 -- A keyed row of another GHL id, same words, a second apart: two photos,
 -- never the same message (the history load's own 20 such pairs).
 o:=public.capture_ghl_history_event(pg_temp.cc_row('CCgid00000000000017','CCcontact0000005','inbound',NULL,'2026-09-21T03:00:00Z','[No text. 1 attachment: jpeg.]'));
 IF o->>'outcome' IS DISTINCT FROM 'inserted' THEN RAISE EXCEPTION 'W7: the first photo must be saved, got %',o; END IF;
 o:=public.capture_ghl_history_event(pg_temp.cc_row('CCgid00000000000018','CCcontact0000005','inbound',NULL,'2026-09-21T03:00:01Z','[No text. 1 attachment: jpeg.]'));
 IF o->>'outcome' IS DISTINCT FROM 'inserted' THEN RAISE EXCEPTION 'W8: a second photo a second later must be saved, got %',o; END IF;
 -- A bracketed row never matches a key-less older row by words either.
 PERFORM pg_temp.cc_legacy('CCcontact0000006','inbound','[No text. 1 attachment: jpeg.]',t,NULL);
 o:=public.capture_ghl_history_event(pg_temp.cc_row('CCgid00000000000019','CCcontact0000006','inbound',NULL,'2026-09-21T02:00:00Z','[No text. 1 attachment: jpeg.]'));
 IF o->>'outcome' IS DISTINCT FROM 'inserted' THEN RAISE EXCEPTION 'W9: a bracketed row must never match by words, got %',o; END IF;
 SELECT count(*) INTO n FROM public.business_events WHERE provider_message_id LIKE 'ghl:CCgid0000000000001%';
 IF n<>8 THEN RAISE EXCEPTION 'W: expected 8 saved history rows, got %',n; END IF;
END $$;
ROLLBACK;

-- 5. The row's own key: the writer answers duplicate exactly as before (no
-- copy_of_other_writer), even when a key-less copy also exists.
BEGIN;
DO $$
DECLARE o jsonb; first_id uuid;
BEGIN
 o:=public.capture_ghl_history_event(pg_temp.cc_row('CCgid00000000000021','CCcontact0000007','outbound','Own key text.','2026-09-22T02:00:00Z'));
 IF o->>'outcome' IS DISTINCT FROM 'inserted' THEN RAISE EXCEPTION 'K1: first save, got %',o; END IF;
 first_id:=(o->>'id')::uuid;
 PERFORM pg_temp.cc_legacy('CCcontact0000007','outbound','Own key text.','2026-09-22T02:00:00Z','CCgid00000000000021');
 o:=public.capture_ghl_history_event(pg_temp.cc_row('CCgid00000000000021','CCcontact0000007','outbound','Own key text.','2026-09-22T02:00:00Z'));
 IF o->>'outcome' IS DISTINCT FROM 'duplicate' OR o ? 'copy_of_other_writer' OR o->>'id'<>first_id::text
 THEN RAISE EXCEPTION 'K2: the own-key duplicate must be the writer''s answer, got %',o; END IF;
 -- The door's earlier refusals are unchanged.
 o:=public.capture_ghl_history_event(pg_temp.cc_row('CCgid00000000000022','CCcontact0000007','outbound','Live row.','2026-09-22T02:00:00Z')
  ||jsonb_build_object('metadata',jsonb_build_object('capture_mode','live')));
 IF o->>'code' IS DISTINCT FROM 'history_row_not_backfill' THEN RAISE EXCEPTION 'K3: a live row must be refused, got %',o; END IF;
END $$;
ROLLBACK;

-- 6. The batch read: one answer per matched input row, none for the rest,
-- and nothing for input that is not an array of objects.
BEGIN;
DO $$
DECLARE c1 uuid; n integer; m record;
BEGIN
 c1:=pg_temp.cc_legacy('CCcontact0000008','outbound','Batch text.','2026-09-23T02:00:00Z','CCgid00000000000031');
 SELECT count(*) INTO n FROM public.context_ghl_message_copies(jsonb_build_array(
  pg_temp.cc_row('CCgid00000000000031','CCcontact0000008','outbound','Batch text.','2026-09-23T02:00:00Z'),
  pg_temp.cc_row('CCgid00000000000032','CCcontact0000008','outbound','Batch text, new.','2026-09-23T02:00:00Z'),
  '"not an object"'::jsonb));
 IF n<>1 THEN RAISE EXCEPTION 'B1: one match expected, got %',n; END IF;
 SELECT * INTO m FROM public.context_ghl_message_copies(jsonb_build_array(
  pg_temp.cc_row('CCgid00000000000031','CCcontact0000008','outbound','Batch text.','2026-09-23T02:00:00Z')));
 IF m.provider_message_id<>'ghl:CCgid00000000000031' OR m.id<>c1 OR m.copy_rule<>'ghl_message_id' THEN RAISE EXCEPTION 'B2: wrong match %',m; END IF;
 SELECT count(*) INTO n FROM public.context_ghl_message_copies('{"a":1}'::jsonb);
 IF n<>0 THEN RAISE EXCEPTION 'B3: a non-array must match nothing'; END IF;
 SELECT count(*) INTO n FROM public.context_ghl_message_copies(NULL);
 IF n<>0 THEN RAISE EXCEPTION 'B4: null must match nothing'; END IF;
 -- A bad time never throws; the row simply cannot match by time.
 SELECT count(*) INTO n FROM public.context_ghl_message_copies(jsonb_build_array(
  pg_temp.cc_row('CCgid00000000000033','CCcontact0000008','outbound','Batch text.','not a time')));
 IF n<>0 THEN RAISE EXCEPTION 'B5: an unreadable time must not match by words'; END IF;
END $$;
ROLLBACK;

-- 7. A fault in the copy check never stops the load: the row is written as
-- before and the answer says so.
BEGIN;
CREATE OR REPLACE FUNCTION public.context_ghl_message_copies(p_rows jsonb)
RETURNS TABLE(provider_message_id text, id uuid, job_id uuid, attribution_status text, source text, copy_rule text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 RAISE EXCEPTION 'copies fault' USING ERRCODE='XX000';
END $$;
DO $$
DECLARE o jsonb;
BEGIN
 o:=public.capture_ghl_history_event(pg_temp.cc_row('CCgid00000000000041','CCcontact0000009','outbound','Fault path text.','2026-09-24T02:00:00Z'));
 IF o->>'outcome' IS DISTINCT FROM 'inserted' OR o->>'copy_check_error' IS DISTINCT FROM 'XX000'
  OR NOT EXISTS(SELECT 1 FROM public.business_events WHERE provider_message_id='ghl:CCgid00000000000041')
 THEN RAISE EXCEPTION 'F1: a copy-check fault must write the row and say so, got %',o; END IF;
END $$;
ROLLBACK;

-- 8. The job record counts what the readers read: one customer text saved
-- twice (the second marked as a copy) is one message in the record, one
-- customer message in the contact counts and one text in the story's lanes.
CREATE FUNCTION pg_temp.cc_text(p_job uuid,p_contact text,p_body text,p_at timestamptz) RETURNS uuid
LANGUAGE plpgsql SET session_replication_role=replica AS $$
DECLARE new_id uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.business_events(id,job_id,event_type,source,contact_id,direction,channel,payload,metadata,occurred_at,event_at,recorded_at,
  context_captured_at,attribution_status,attribution_step,attribution_confidence,attributed_at,match_method)
  VALUES(new_id,p_job,'client.reply','copies_contract',p_contact,'inbound','sms',jsonb_build_object('body',p_body),
   jsonb_build_object('written_as','service_role'),p_at,p_at,p_at,p_at,'direct',1,1,p_at,'direct_job_id');
 RETURN new_id;
END $$;
CREATE FUNCTION pg_temp.cc_mark(p_copy uuid,p_original uuid) RETURNS void
LANGUAGE sql SET session_replication_role=replica AS $$
 UPDATE public.business_events SET metadata=metadata||jsonb_build_object('duplicate_of',p_original::text) WHERE id=p_copy $$;
BEGIN;
DO $$
DECLARE j uuid:=gen_random_uuid(); orig uuid; copy uuid; other uuid; n integer; cm integer; texts integer; t timestamptz:=now()-interval '3 days';
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,metadata,created_at)
  VALUES(j,'00000000-0000-0000-0000-000000000001','scheduled','fencing','CC-REC','CCcontactRecord01','{}',now()-interval '30 days');
 orig:=pg_temp.cc_text(j,'CCcontactRecord01','Can you come Tuesday?',t);
 copy:=pg_temp.cc_text(j,'CCcontactRecord01','Can you come Tuesday?',t+interval '1 second');
 other:=pg_temp.cc_text(j,'CCcontactRecord01','Thanks, see you then.',t+interval '1 hour');
 SELECT count(*) INTO n FROM public.context_job_record_messages(ARRAY[j]) m WHERE m.source_table='business_events';
 SELECT c.customer_messages INTO cm FROM public.context_job_record_contact(ARRAY[j]) c;
 texts:=(public.context_job_story_meta(j)->'lanes'->>'texts')::integer;
 IF n<>3 OR cm<>3 OR texts<>3 THEN RAISE EXCEPTION 'R0 fixture: before marking expected 3 3 3, got % % %',n,cm,texts; END IF;
 PERFORM pg_temp.cc_mark(copy,orig);
 SELECT count(*) INTO n FROM public.context_job_record_messages(ARRAY[j]) m WHERE m.source_table='business_events';
 IF n<>2 OR EXISTS(SELECT 1 FROM public.context_job_record_messages(ARRAY[j]) m WHERE m.source_id=copy::text)
 THEN RAISE EXCEPTION 'R1: a marked copy must not be a message of the job, got %',n; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.context_job_record_messages(ARRAY[j]) m WHERE m.source_id=orig::text)
 THEN RAISE EXCEPTION 'R1: the original must stay'; END IF;
 SELECT c.customer_messages INTO cm FROM public.context_job_record_contact(ARRAY[j]) c;
 IF cm<>2 THEN RAISE EXCEPTION 'R2: the contact counts must count the message once, got %',cm; END IF;
 texts:=(public.context_job_story_meta(j)->'lanes'->>'texts')::integer;
 IF texts<>2 THEN RAISE EXCEPTION 'R3: the story lanes must count the text once, got %',texts; END IF;
 IF EXISTS(SELECT 1 FROM public.context_job_record_timeline(ARRAY[j]) t WHERE t.source_id=copy::text)
 THEN RAISE EXCEPTION 'R4: a marked copy must not be on the timeline'; END IF;
END $$;
ROLLBACK;
