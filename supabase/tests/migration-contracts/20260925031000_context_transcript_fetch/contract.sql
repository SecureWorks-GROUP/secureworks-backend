-- T2 contract: the transcript fetcher's database half. Every fixture write is
-- rolled back. Call rows carry the recorded named rows' ids, statuses and
-- durations (transcript_fixtures.ts); no words.

CREATE FUNCTION pg_temp.t2_call(p_id text,p_contact text,p_at timestamptz,p_status text,p_duration numeric,
 p_type text DEFAULT 'client.call_logged',p_line text DEFAULT '774') RETURNS uuid LANGUAGE sql AS $$
 INSERT INTO public.business_events(event_type,source,entity_type,entity_id,contact_id,event_at,provider_message_id,channel,direction,payload,metadata)
 VALUES(p_type,'ghl-message-reconcile','contact',p_contact,p_contact,p_at,'ghl:'||p_id,'call','inbound',
  jsonb_build_object('call_status',p_status,'duration_seconds',p_duration,'from_line',p_line,'ghl_message_id',p_id,'call_sid','CAfixture'),
  '{"capture_mode":"live"}') RETURNING id
$$;
CREATE FUNCTION pg_temp.t2_tx(p_id text,p_contact text,p_at timestamptz,p_mode text DEFAULT 'live') RETURNS uuid LANGUAGE sql AS $$
 INSERT INTO public.business_events(event_type,source,entity_type,entity_id,contact_id,event_at,provider_message_id,channel,direction,payload,metadata)
 VALUES('call.transcript_completed','ghl-call-transcript','contact',p_contact,p_contact,p_at,'ghltx:'||p_id,'call','inbound',
  jsonb_build_object('ghl_call_id',p_id,'transcript','Placeholder words.'),jsonb_build_object('capture_mode',p_mode)) RETURNING id
$$;
CREATE FUNCTION pg_temp.t2_keys(p jsonb) RETURNS text[] LANGUAGE sql AS $$
 SELECT coalesce(array_agg(a->>'key' ORDER BY a->>'key'),'{}') FROM jsonb_array_elements(p->'alarms') a
$$;
CREATE FUNCTION pg_temp.t2_rec(p jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT public.record_call_transcript_fetch(p) $$;
CREATE FUNCTION pg_temp.t2_refused(p jsonb) RETURNS text LANGUAGE plpgsql AS $$
BEGIN PERFORM public.record_call_transcript_fetch(p); RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;

BEGIN;
-- 1. Nothing widens public access (X32, review M7).
DO $$
DECLARE f regprocedure;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_transcript_capture_policy()','public.context_transcript_fetch_flag()',
  'public.record_call_transcript_fetch(jsonb)','public.context_call_transcript_eligible(text,text,jsonb)',
  'public.context_transcript_due_calls(integer)','public.context_transcript_backfill_contacts(text,integer)',
  'public.context_transcript_capture_status()','public.trigger_ghl_call_transcript_fetch()','public.automation_switch_cron_lanes()']::regprocedure[] LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') OR has_function_privilege('public',f,'EXECUTE')
  THEN RAISE EXCEPTION 't2 public execute on %',f; END IF;
  IF (SELECT proconfig FROM pg_proc WHERE oid=f) IS NULL THEN RAISE EXCEPTION 't2 % has no fixed search_path',f; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_transcript_fetch_flag()','public.record_call_transcript_fetch(jsonb)',
  'public.context_transcript_due_calls(integer)','public.context_transcript_backfill_contacts(text,integer)',
  'public.context_transcript_capture_status()','public.trigger_ghl_call_transcript_fetch()']::regprocedure[] LOOP
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=f) THEN RAISE EXCEPTION 't2 % must be SECURITY DEFINER',f; END IF;
 END LOOP;
 IF has_function_privilege('service_role','public.trigger_ghl_call_transcript_fetch()','EXECUTE')
 THEN RAISE EXCEPTION 't2 the cron caller must not be callable by service_role'; END IF;
 IF NOT has_function_privilege('service_role','public.record_call_transcript_fetch(jsonb)','EXECUTE')
 THEN RAISE EXCEPTION 't2 service_role must reach the writer'; END IF;
 -- The table: RLS on, no policy, nothing for PUBLIC, anon or authenticated,
 -- service_role may read it and only the writer writes it.
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.call_transcript_fetches'::regclass) THEN RAISE EXCEPTION 't2 RLS off'; END IF;
 IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.call_transcript_fetches'::regclass) THEN RAISE EXCEPTION 't2 a policy exists'; END IF;
 IF has_table_privilege('anon','public.call_transcript_fetches','SELECT') OR has_table_privilege('authenticated','public.call_transcript_fetches','SELECT')
  OR has_table_privilege('anon','public.call_transcript_fetches','INSERT') OR has_table_privilege('authenticated','public.call_transcript_fetches','UPDATE')
 THEN RAISE EXCEPTION 't2 public table access'; END IF;
 IF NOT has_table_privilege('service_role','public.call_transcript_fetches','SELECT')
  OR has_table_privilege('service_role','public.call_transcript_fetches','INSERT')
  OR has_table_privilege('service_role','public.call_transcript_fetches','UPDATE')
  OR has_table_privilege('service_role','public.call_transcript_fetches','DELETE')
 THEN RAISE EXCEPTION 't2 service_role table grants'; END IF;
 -- The capture lane owns the job; the three earlier jobs keep their lanes
 -- (containment, so a later slice's own job does not break this).
 IF NOT (SELECT array_agg(cron_jobname||':'||lane ORDER BY cron_jobname) FROM public.automation_switch_cron_lanes())
    @> ARRAY['contact-matching:attribution','ghl-call-transcript-fetch:capture','ghl-message-reconcile:capture','monitor-inbox-poll:capture']
  OR (SELECT count(*) FROM public.automation_switch_cron_lanes() WHERE cron_jobname='ghl-call-transcript-fetch')<>1
 THEN RAISE EXCEPTION 't2 cron lane list %',(SELECT array_agg(to_jsonb(l)) FROM public.automation_switch_cron_lanes() l); END IF;
END $$;
ROLLBACK;

BEGIN;
-- 1b. The file C1d's contract uses to stand its lane list back up is that body.
\ir c1d_cron_lanes.sql
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.automation_switch_cron_lanes()'::regprocedure)<>'459035de5d3f7f7af49c36f09d9be29e'
 THEN RAISE EXCEPTION 't2 c1d_cron_lanes.sql is not the C1d body'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 2. The fetch flag fails closed; the cron caller makes no HTTP call while it
-- is off, and tries to post as soon as it is on (no pg_net here, so the
-- attempt shows as an error).
DO $$
DECLARE f jsonb; attempted boolean:=false;
BEGIN
 f:=public.context_transcript_fetch_flag();
 IF f<>'{"enabled":false,"state":"missing","updated_at":null}'::jsonb THEN RAISE EXCEPTION 't2 missing flag must read off %',f; END IF;
 PERFORM public.trigger_ghl_call_transcript_fetch();
 -- The old Whisper flag is not this flag (review B1).
 INSERT INTO public.feature_flags(flag_name,enabled) VALUES('evidence_transcript_capture',true);
 IF (public.context_transcript_fetch_flag()->>'enabled')::boolean THEN RAISE EXCEPTION 't2 evidence_transcript_capture must not turn the fetcher on'; END IF;
 INSERT INTO public.feature_flags(flag_name,enabled) VALUES('ghl_call_transcript_fetch_v1',false);
 IF public.context_transcript_fetch_flag()->>'state'<>'present' OR (public.context_transcript_fetch_flag()->>'enabled')::boolean
 THEN RAISE EXCEPTION 't2 flag row off'; END IF;
 PERFORM public.trigger_ghl_call_transcript_fetch();
 UPDATE public.feature_flags SET enabled=true WHERE flag_name='ghl_call_transcript_fetch_v1';
 BEGIN
  PERFORM public.trigger_ghl_call_transcript_fetch();
 EXCEPTION WHEN OTHERS THEN attempted:=true;
 END;
 IF NOT attempted THEN RAISE EXCEPTION 't2 the cron caller must post while the flag is on'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 3. Eligibility from the stored call row (review M1), on the recorded rows.
DO $$
DECLARE r record;
BEGIN
 FOR r IN SELECT * FROM (VALUES
  -- N1: completed 109 s
  ('client.call_logged','ghl:6kn6WmrtfTMvhEJtmfeJ','{"call_status":"completed","duration_seconds":109}'::jsonb,true),
  -- N2: voicemail, no duration
  ('client.call_logged','ghl:Py9PovOwc4I4vNkn9jXg','{"call_status":"voicemail","duration_seconds":null}',true),
  -- NODUR: completed with no duration recorded, yet 90 sentences
  ('client.call_logged','ghl:MeVPH47LXDbgcvPUAkjY','{"call_status":"completed","duration_seconds":null}',true),
  ('client.call_logged','ghl:MeVPH47LXDbgcvPUAkjY','{"call_status":"completed"}',true),
  -- a 4 s completed call (MsP4f11woWeSc0k573Pt: one greeting sentence)
  ('client.call_logged','ghl:MsP4f11woWeSc0k573Pt','{"call_status":"completed","duration_seconds":4}',false),
  -- NOANS: no-answer
  ('client.call_logged','ghl:meYkjPC1Se4b7vCLZGaZ','{"call_status":"no-answer","duration_seconds":null}',false),
  -- a tool-started call before GHL gave a status: the provider re-read decides
  ('client.call_initiated','ghl:toolCall000001','{}',true),
  ('client.call_logged','ghl:toolCall000001','{}',false),
  -- the legacy workflow row has no GHL key: never selected
  ('client.call_complete',NULL,'{"call_status":"completed","duration_seconds":140}',false),
  ('client.call_logged','ghltx:6kn6WmrtfTMvhEJtmfeJ','{"call_status":"completed","duration_seconds":109}',false)
 ) AS t(etype,pkey,payload,expected) LOOP
  IF public.context_call_transcript_eligible(r.etype,r.pkey,r.payload) IS DISTINCT FROM r.expected
  THEN RAISE EXCEPTION 't2 eligibility % % % expected %',r.etype,r.pkey,r.payload,r.expected; END IF;
 END LOOP;
END $$;
ROLLBACK;

BEGIN;
-- 4. Calls due now: 14 days (review M11), eligible, no terminal outcome, next
-- try due, oldest first; a call with a transcript row comes back for "saved".
SELECT pg_temp.t2_call('6kn6WmrtfTMvhEJtmfeJ','Oxqi7eCx2rGCsS0BXOH2',now()-interval '20 minutes','completed',109);
SELECT pg_temp.t2_call('Py9PovOwc4I4vNkn9jXg','Oxqi7eCx2rGCsS0BXOH2',now()-interval '9 hours','voicemail',NULL);
SELECT pg_temp.t2_call('MeVPH47LXDbgcvPUAkjY','lYPee0K2DuQHXH2xHL1P',now()-interval '3 days','completed',NULL,'client.call_logged','772');
SELECT pg_temp.t2_call('MsP4f11woWeSc0k573Pt','Oxqi7eCx2rGCsS0BXOH2',now()-interval '2 hours','completed',4);
SELECT pg_temp.t2_call('meYkjPC1Se4b7vCLZGaZ','Oxqi7eCx2rGCsS0BXOH2',now()-interval '3 hours','no-answer',NULL);
SELECT pg_temp.t2_call('bJNGSorrVRMHxehZtQHT','Oxqi7eCx2rGCsS0BXOH2',now()-interval '15 days','completed',303);
SELECT pg_temp.t2_call('Ag9DKkqpfsadWkJS8jst','lYPee0K2DuQHXH2xHL1P',now()-interval '8 days','completed',127,'client.call_logged','772');
SELECT pg_temp.t2_tx('Ag9DKkqpfsadWkJS8jst','lYPee0K2DuQHXH2xHL1P',now()-interval '8 days');
SELECT pg_temp.t2_call('0Gct0u0TQNZox8DRAVLo','Oxqi7eCx2rGCsS0BXOH2',now()-interval '2 days','completed',67);
SELECT pg_temp.t2_call('ZKxEtfBzwb5qZx3o6p3v','Oxqi7eCx2rGCsS0BXOH2',now()-interval '4 days','completed',22);
SELECT pg_temp.t2_call('ps9i5b2x4f8WqRjEe1Bs','Oxqi7eCx2rGCsS0BXOH2',now()-interval '5 days','completed',21);
DO $$
DECLARE ids text[]; e3 uuid; e4 uuid;
BEGIN
 SELECT id INTO e3 FROM public.business_events WHERE provider_message_id='ghl:0Gct0u0TQNZox8DRAVLo';
 SELECT id INTO e4 FROM public.business_events WHERE provider_message_id='ghl:ZKxEtfBzwb5qZx3o6p3v';
 -- 0Gct: tried once, next try in 2 minutes (not due). ZKxE: terminal not_returned (six tries).
 PERFORM pg_temp.t2_rec(jsonb_build_object('call_message_id','0Gct0u0TQNZox8DRAVLo','call_event_id',e3,'result','not_ready','code','empty'));
 PERFORM pg_temp.t2_rec(jsonb_build_object('call_message_id','ZKxEtfBzwb5qZx3o6p3v','call_event_id',e4,'result','not_ready','code','empty'))
  FROM generate_series(1,6);
 SELECT array_agg(d.call_message_id ORDER BY d.event_at) INTO ids FROM public.context_transcript_due_calls(40) d;
 IF ids IS DISTINCT FROM ARRAY['Ag9DKkqpfsadWkJS8jst','ps9i5b2x4f8WqRjEe1Bs','MeVPH47LXDbgcvPUAkjY','Py9PovOwc4I4vNkn9jXg','6kn6WmrtfTMvhEJtmfeJ']
 THEN RAISE EXCEPTION 't2 due calls %',ids; END IF;
 -- Oldest first, and the row the fetcher needs to build the transcript.
 IF (SELECT array_agg(d.call_message_id) FROM public.context_transcript_due_calls(40) d) IS DISTINCT FROM ids THEN RAISE EXCEPTION 't2 due order'; END IF;
 IF (SELECT d.transcript_event_id IS NULL FROM public.context_transcript_due_calls(40) d WHERE d.call_message_id='Ag9DKkqpfsadWkJS8jst')
 THEN RAISE EXCEPTION 't2 crash replay: the existing transcript row must be returned'; END IF;
 IF (SELECT row(d.contact_id,d.duration_seconds,d.from_line,d.capture_mode,d.attempts)::text FROM public.context_transcript_due_calls(40) d
     WHERE d.call_message_id='6kn6WmrtfTMvhEJtmfeJ') IS DISTINCT FROM '(Oxqi7eCx2rGCsS0BXOH2,109,774,live,0)'
 THEN RAISE EXCEPTION 't2 due row shape'; END IF;
 IF (SELECT count(*) FROM public.context_transcript_due_calls(2))<>2 THEN RAISE EXCEPTION 't2 limit'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 5. The writer: the backoff is the database's, terminal is final (§2 steps 5, 6).
SELECT pg_temp.t2_call('6kn6WmrtfTMvhEJtmfeJ','Oxqi7eCx2rGCsS0BXOH2',now()-interval '20 minutes','completed',109);
SELECT pg_temp.t2_call('0Gct0u0TQNZox8DRAVLo','Oxqi7eCx2rGCsS0BXOH2',now()-interval '2 days','completed',67);
SELECT pg_temp.t2_call('bJNGSorrVRMHxehZtQHT','Oxqi7eCx2rGCsS0BXOH2',now()-interval '72 days','completed',303);
SELECT pg_temp.t2_call('Py9PovOwc4I4vNkn9jXg','Oxqi7eCx2rGCsS0BXOH2',now()-interval '9 hours','voicemail',NULL);
DO $$
DECLARE e1 uuid; e3 uuid; e10 uuid; e2 uuid; r jsonb; f public.call_transcript_fetches; i integer; steps integer[]:=ARRAY[2,5,15,60,360,1440]; tx uuid;
BEGIN
 SELECT id INTO e1 FROM public.business_events WHERE provider_message_id='ghl:6kn6WmrtfTMvhEJtmfeJ';
 SELECT id INTO e3 FROM public.business_events WHERE provider_message_id='ghl:0Gct0u0TQNZox8DRAVLo';
 SELECT id INTO e10 FROM public.business_events WHERE provider_message_id='ghl:bJNGSorrVRMHxehZtQHT';
 SELECT id INTO e2 FROM public.business_events WHERE provider_message_id='ghl:Py9PovOwc4I4vNkn9jXg';
 -- Not ready: 2 min, 5 min, 15 min, 1 h, 6 h, then terminal not_returned.
 FOR i IN 1..5 LOOP
  r:=pg_temp.t2_rec(jsonb_build_object('call_message_id','0Gct0u0TQNZox8DRAVLo','call_event_id',e3,'result','not_ready','code','transcript_not_found',
   'provider_status','completed','provider_duration_seconds',67));
  SELECT * INTO f FROM public.call_transcript_fetches WHERE call_message_id='0Gct0u0TQNZox8DRAVLo';
  IF f.outcome<>'pending' OR f.attempts<>i OR f.next_at < clock_timestamp()+make_interval(mins=>steps[i])-interval '1 minute'
   OR f.next_at > clock_timestamp()+make_interval(mins=>steps[i])+interval '1 minute'
  THEN RAISE EXCEPTION 't2 backoff step % %',i,row_to_json(f); END IF;
 END LOOP;
 r:=pg_temp.t2_rec(jsonb_build_object('call_message_id','0Gct0u0TQNZox8DRAVLo','call_event_id',e3,'result','not_ready','code','empty'));
 SELECT * INTO f FROM public.call_transcript_fetches WHERE call_message_id='0Gct0u0TQNZox8DRAVLo';
 IF r->>'outcome'<>'not_returned' OR f.outcome<>'not_returned' OR f.next_at IS NOT NULL OR f.finished_at IS NULL OR f.attempts<>6
  OR f.provider_status<>'completed' OR f.provider_duration_seconds<>67 THEN RAISE EXCEPTION 't2 terminal not_returned %',row_to_json(f); END IF;
 -- Terminal is never reopened, not even by a save.
 r:=pg_temp.t2_rec(jsonb_build_object('call_message_id','0Gct0u0TQNZox8DRAVLo','call_event_id',e3,'result','not_ready','code','empty'));
 IF r->>'outcome'<>'unchanged' OR (SELECT attempts FROM public.call_transcript_fetches WHERE call_message_id='0Gct0u0TQNZox8DRAVLo')<>6
 THEN RAISE EXCEPTION 't2 terminal reopened %',r; END IF;

 -- Errors: same ladder, terminal failed:<code> after the sixth.
 FOR i IN 1..6 LOOP
  r:=pg_temp.t2_rec(jsonb_build_object('call_message_id','6kn6WmrtfTMvhEJtmfeJ','call_event_id',e1,'result','error','code','http_500'));
 END LOOP;
 SELECT * INTO f FROM public.call_transcript_fetches WHERE call_message_id='6kn6WmrtfTMvhEJtmfeJ';
 IF r->>'outcome'<>'failed:http_500' OR f.outcome<>'failed' OR f.failure_code<>'http_500' THEN RAISE EXCEPTION 't2 terminal failed %',row_to_json(f); END IF;

 -- Awaiting agreement is not an attempt; it waits 5 minutes and remembers the read.
 r:=pg_temp.t2_rec(jsonb_build_object('call_message_id','Py9PovOwc4I4vNkn9jXg','call_event_id',e2,'result','awaiting_agreement',
  'sentences',1,'digest',repeat('a',64)));
 SELECT * INTO f FROM public.call_transcript_fetches WHERE call_message_id='Py9PovOwc4I4vNkn9jXg';
 IF f.attempts<>0 OR f.seen_sentences<>1 OR f.seen_digest<>repeat('a',64) OR f.outcome<>'pending'
  OR f.next_at < clock_timestamp()+interval '4 minutes' OR f.next_at > clock_timestamp()+interval '6 minutes'
 THEN RAISE EXCEPTION 't2 awaiting agreement %',row_to_json(f); END IF;
 -- Saved needs the transcript row itself.
 IF pg_temp.t2_refused(jsonb_build_object('call_message_id','Py9PovOwc4I4vNkn9jXg','call_event_id',e2,'result','saved','transcript_event_id',e1))
    NOT LIKE '%transcript_fetch_transcript_not_found%' THEN RAISE EXCEPTION 't2 saved must name the ghltx row'; END IF;
 tx:=pg_temp.t2_tx('Py9PovOwc4I4vNkn9jXg','Oxqi7eCx2rGCsS0BXOH2',now()-interval '9 hours');
 r:=pg_temp.t2_rec(jsonb_build_object('call_message_id','Py9PovOwc4I4vNkn9jXg','call_event_id',e2,'result','saved','transcript_event_id',tx));
 SELECT * INTO f FROM public.call_transcript_fetches WHERE call_message_id='Py9PovOwc4I4vNkn9jXg';
 IF f.outcome<>'saved' OR f.transcript_event_id<>tx OR f.finished_at IS NULL OR f.last_code<>'saved' THEN RAISE EXCEPTION 't2 saved %',row_to_json(f); END IF;

 -- History load: a 72-day-old call with nothing is final at once; a young one backs off.
 r:=pg_temp.t2_rec(jsonb_build_object('call_message_id','bJNGSorrVRMHxehZtQHT','call_event_id',e10,'mode','backfill','result','not_ready','code','empty'));
 IF r->>'outcome'<>'not_returned' OR (SELECT mode FROM public.call_transcript_fetches WHERE call_message_id='bJNGSorrVRMHxehZtQHT')<>'backfill'
 THEN RAISE EXCEPTION 't2 backfill old not_ready %',r; END IF;

 -- Refusals: malformed, unknown key, the wrong call row, a missing code.
 IF pg_temp.t2_refused('{"call_message_id":"6kn6WmrtfTMvhEJtmfeJ","result":"saved","words":"x"}') NOT LIKE '%transcript_fetch_invalid%' THEN RAISE EXCEPTION 't2 unknown key'; END IF;
 IF pg_temp.t2_refused(jsonb_build_object('call_message_id','0Gct0u0TQNZox8DRAVLo','call_event_id',e1,'result','not_ready'))
    NOT LIKE '%transcript_fetch_call_not_found%' THEN RAISE EXCEPTION 't2 wrong call row'; END IF;
 IF pg_temp.t2_refused(jsonb_build_object('call_message_id','0Gct0u0TQNZox8DRAVLo','call_event_id',e3,'result','error'))
    NOT LIKE '%transcript_fetch_code_required%' THEN RAISE EXCEPTION 't2 error without code'; END IF;
 IF pg_temp.t2_refused(jsonb_build_object('call_message_id','0Gct0u0TQNZox8DRAVLo','call_event_id',e3,'result','error','code','Has Words'))
    NOT LIKE '%transcript_fetch_code_invalid%' THEN RAISE EXCEPTION 't2 code shape'; END IF;
 IF pg_temp.t2_refused(jsonb_build_object('call_message_id','bad id','call_event_id',e3,'result','not_ready'))
    NOT LIKE '%transcript_fetch_call_invalid%' THEN RAISE EXCEPTION 't2 id shape'; END IF;
END $$;
-- Purge: terminal records older than 30 days go, pending ones never.
UPDATE public.call_transcript_fetches SET finished_at=now()-interval '31 days' WHERE call_message_id='0Gct0u0TQNZox8DRAVLo';
DO $$
DECLARE e1 uuid; r jsonb;
BEGIN
 SELECT id INTO e1 FROM public.business_events WHERE provider_message_id='ghl:ZKxEtfBzwb5qZx3o6p3v';
 IF e1 IS NULL THEN e1:=pg_temp.t2_call('ZKxEtfBzwb5qZx3o6p3v','Oxqi7eCx2rGCsS0BXOH2',now()-interval '4 days','completed',22); END IF;
 r:=pg_temp.t2_rec(jsonb_build_object('call_message_id','ZKxEtfBzwb5qZx3o6p3v','call_event_id',e1,'result','not_ready','code','empty'));
 IF (r->>'purged')::integer<>1 OR EXISTS (SELECT 1 FROM public.call_transcript_fetches WHERE call_message_id='0Gct0u0TQNZox8DRAVLo')
 THEN RAISE EXCEPTION 't2 purge %',r; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 6. History load contacts: the jobs live now (owner, 24 Sep 2026), through
-- jobs.ghl_contact_id, ascending, resumable.
INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id) VALUES
 ('10000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000001','in_progress','patio','T2-LIVE-1','Oxqi7eCx2rGCsS0BXOH2'),
 ('10000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000001','quoted','fencing','T2-QUOTED-SENT','lYPee0K2DuQHXH2xHL1P'),
 ('10000000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000001','quoted','fencing','T2-QUOTED-OLD','contactQuotedOld01'),
 ('10000000-0000-4000-8000-000000000004','00000000-0000-0000-0000-000000000001','draft','fencing','T2-DRAFT-NONE','contactDraftNone01'),
 ('10000000-0000-4000-8000-000000000005','00000000-0000-0000-0000-000000000001','complete','fencing','T2-DONE','contactComplete001'),
 ('10000000-0000-4000-8000-000000000006','00000000-0000-0000-0000-000000000001','accepted','fencing','T2-NO-CONTACT',NULL),
 ('10000000-0000-4000-8000-000000000007','00000000-0000-0000-0000-000000000001','scheduled','patio','T2-LIVE-2','Oxqi7eCx2rGCsS0BXOH2'),
 ('10000000-0000-4000-8000-000000000008','00000000-0000-0000-0000-000000000001','draft','fencing','T2-DRAFT-REV','contactDraftRev01');
INSERT INTO public.job_documents(job_id,type,sent_at) VALUES
 ('10000000-0000-4000-8000-000000000002','quote',now()-interval '10 days'),
 ('10000000-0000-4000-8000-000000000003','quote',now()-interval '90 days');
INSERT INTO public.quote_revisions(job_id,version,totals_snapshot_json,released_via,sent_at) VALUES ('10000000-0000-4000-8000-000000000008',1,'{}','send-quote/send',now()-interval '59 days');
DO $$
DECLARE got text;
BEGIN
 SELECT string_agg(c.ghl_contact_id||'='||array_to_string(c.job_numbers,'+'),' ' ORDER BY c.ghl_contact_id COLLATE "C") INTO got
 FROM public.context_transcript_backfill_contacts(NULL,50) c;
 IF got IS DISTINCT FROM 'Oxqi7eCx2rGCsS0BXOH2=T2-LIVE-1+T2-LIVE-2 contactDraftRev01=T2-DRAFT-REV lYPee0K2DuQHXH2xHL1P=T2-QUOTED-SENT'
 THEN RAISE EXCEPTION 't2 backfill contacts %',got; END IF;
 SELECT string_agg(c.ghl_contact_id,' ') INTO got FROM public.context_transcript_backfill_contacts('Oxqi7eCx2rGCsS0BXOH2',1) c;
 IF got IS DISTINCT FROM 'contactDraftRev01' THEN RAISE EXCEPTION 't2 backfill paging %',got; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 7. Status block. Flag off (production today): counts, no alarms; the
-- composer carries the block instead of F1b's null.
SELECT pg_temp.t2_call('6kn6WmrtfTMvhEJtmfeJ','Oxqi7eCx2rGCsS0BXOH2',now()-interval '20 minutes','completed',109);
SELECT pg_temp.t2_call('0Gct0u0TQNZox8DRAVLo','Oxqi7eCx2rGCsS0BXOH2',now()-interval '6 hours','completed',67);
SELECT pg_temp.t2_call('or4prAFHcG4xYKkLgx1u','Oxqi7eCx2rGCsS0BXOH2',now()-interval '7 hours','completed',108,'client.call_logged','772');
SELECT pg_temp.t2_call('FJkelN20IF8jRd5yTHAd','Oxqi7eCx2rGCsS0BXOH2',now()-interval '8 hours','completed',244);
SELECT pg_temp.t2_call('txTXqexfAk8zndoPS0xH','Oxqi7eCx2rGCsS0BXOH2',now()-interval '9 hours','completed',426);
SELECT pg_temp.t2_call('l3jVBneopqTPApBjG1Xt','Oxqi7eCx2rGCsS0BXOH2',now()-interval '10 hours','completed',326);
SELECT pg_temp.t2_tx('l3jVBneopqTPApBjG1Xt','Oxqi7eCx2rGCsS0BXOH2',now()-interval '10 hours');
-- aged out: 14 days and 3 hours old, never tried.
SELECT pg_temp.t2_call('bJNGSorrVRMHxehZtQHT','Oxqi7eCx2rGCsS0BXOH2',now()-interval '14 days 3 hours','completed',303);
DO $$
DECLARE s jsonb:=public.context_transcript_capture_status(); c jsonb:=public.context_pipeline_status();
BEGIN
 IF s->'fetch_flag'<>'{"enabled":false,"state":"missing","updated_at":null}'::jsonb THEN RAISE EXCEPTION 't2 flag %',s->'fetch_flag'; END IF;
 IF s->'alarms'<>'[]'::jsonb THEN RAISE EXCEPTION 't2 flag off must raise no alarm %',s->'alarms'; END IF;
 IF s#>>'{calls,due_now}'<>'5' OR s#>>'{calls,never_tried}'<>'5' OR s#>>'{calls,aged_out_unfetched_24h}'<>'1'
 THEN RAISE EXCEPTION 't2 calls %',s->'calls'; END IF;
 IF s#>>'{coverage_24h,eligible}'<>'5' OR s#>>'{coverage_24h,with_transcript}'<>'1'
  OR s#>'{coverage_24h,by_line,772}'<>'{"eligible":1,"with_transcript":0}'::jsonb
 THEN RAISE EXCEPTION 't2 coverage %',s->'coverage_24h'; END IF;
 IF NOT s->'not_measured' @> '["call_transcript_split"]' THEN RAISE EXCEPTION 't2 not_measured'; END IF;
 IF jsonb_typeof(c->'transcript_capture')<>'object' OR c#>>'{transcript_capture,policy,fetch_flag}'<>'ghl_call_transcript_fetch_v1'
 THEN RAISE EXCEPTION 't2 composer block %',c->'transcript_capture'; END IF;
 IF s::text LIKE '%Placeholder%' THEN RAISE EXCEPTION 't2 status must carry no words'; END IF;
END $$;
-- Flag on for a day with no run and no save: all four alarms.
INSERT INTO public.feature_flags(flag_name,enabled,updated_at) VALUES('ghl_call_transcript_fetch_v1',true,now()-interval '3 days');
DO $$
DECLARE s jsonb:=public.context_transcript_capture_status();
BEGIN
 IF pg_temp.t2_keys(s)<>ARRAY['transcript_aged_out','transcript_coverage_low','transcript_fetch_failing','transcript_fetch_stale']
 THEN RAISE EXCEPTION 't2 alarms %',s->'alarms'; END IF;
 IF NOT (public.context_pipeline_status()->'alarms') @> '[{"block":"transcript_capture","key":"transcript_fetch_stale"}]'
 THEN RAISE EXCEPTION 't2 composer alarms'; END IF;
END $$;
-- A fresh healthy run: stale clears; a run with many failed reads is failing.
SELECT public.record_capture_run('{"source":"ghl_call_transcript","status":"succeeded","counts":{"attempts":10,"errors":3}}');
DO $$
DECLARE s jsonb:=public.context_transcript_capture_status();
BEGIN
 IF 'transcript_fetch_stale'=ANY(pg_temp.t2_keys(s)) THEN RAISE EXCEPTION 't2 stale after a fresh run %',s->'alarms'; END IF;
 IF NOT 'transcript_fetch_failing'=ANY(pg_temp.t2_keys(s)) OR s#>>'{fetcher,errors_24h}'<>'3' THEN RAISE EXCEPTION 't2 failing %',s; END IF;
END $$;
-- The capture lane off silences every alarm (nothing is meant to run).
UPDATE public.automation_switches SET capture=false WHERE id=1;
DO $$
BEGIN
 IF public.context_transcript_capture_status()->'alarms'<>'[]'::jsonb THEN RAISE EXCEPTION 't2 lane off alarms'; END IF;
END $$;
ROLLBACK;
