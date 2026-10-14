\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.rc_assert(ok boolean, message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'recheck contract: %', message; END IF; END $$;
-- Queue ordering and limits are behavioral; the real ladder is exercised below.
-- Isolate queue mechanics; the next transaction uses the real ladder and Luna writer.
TRUNCATE public.business_events CASCADE;
ALTER TABLE public.business_events DISABLE TRIGGER USER;
UPDATE public.automation_switches SET all_stop=false, attribution=true WHERE id=1;
CREATE TEMP TABLE rc_seen(seq bigint GENERATED ALWAYS AS IDENTITY, id uuid);
CREATE OR REPLACE FUNCTION public.resolve_context_attribution(e public.business_events)
RETURNS public.business_events LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO rc_seen(id) VALUES(e.id);
 e.attribution_checked_at:=clock_timestamp();
 e.attribution_status:='admin_bucket';
 RETURN e;
END $$;
INSERT INTO public.business_events(id,event_type,channel,occurred_at,attribution_checked_at,contact_id,payload) VALUES
 ('00000000-0000-0000-0000-000000000010','makesafe.reconcile.job_no_email','email','2020-01-01',NULL,'rc-a','{}'),
 ('00000000-0000-0000-0000-000000000011','client.email_in','email','2026-01-01','2026-01-01','rc-a','{}'),
 ('00000000-0000-0000-0000-000000000012','call.transcript_completed','call','2026-02-01',NULL,'rc-a','{}'),
 ('00000000-0000-0000-0000-000000000013','client.reply',NULL,'2026-02-01',NULL,'rc-a','{}'),
 ('00000000-0000-0000-0000-000000000014','client.sms_out',NULL,'2026-02-02',NULL,'rc-b','{}'),
 ('00000000-0000-0000-0000-000000000015','makesafe.intake_cancellation_detected',NULL,'2020-01-02',NULL,'rc-b','{}');
SELECT pg_temp.rc_assert(public.rerun_context_attribution(1,NULL)=1,'per-call limit');
SELECT pg_temp.rc_assert((SELECT id FROM rc_seen ORDER BY seq LIMIT 1)='00000000-0000-0000-0000-000000000012','messages must precede never-checked machines');
SELECT pg_temp.rc_assert(public.rerun_context_attribution(1,NULL)=1,'second call');
SELECT pg_temp.rc_assert((SELECT id FROM rc_seen ORDER BY seq DESC LIMIT 1)='00000000-0000-0000-0000-000000000013','message rotation and id tiebreak');
SELECT pg_temp.rc_assert(public.rerun_context_attribution(1,'rc-a')=1,'contact-scoped limit');
SELECT pg_temp.rc_assert((SELECT id FROM rc_seen ORDER BY seq DESC LIMIT 1)='00000000-0000-0000-0000-000000000011','old checked message before machine; contact scope excludes other message');
SELECT pg_temp.rc_assert(NOT EXISTS(SELECT 1 FROM public.business_events WHERE metadata->>'capture_mode'='relink'),'still-bucket rows must not change capture mode');
SELECT pg_temp.rc_assert(public.rerun_context_attribution(0,NULL)=0 AND public.rerun_context_attribution(-1,NULL)=0,'zero and negative limit');
UPDATE public.automation_switches SET attribution=false WHERE id=1;
SELECT pg_temp.rc_assert(public.rerun_context_attribution(250,NULL)=0,'lane off');
UPDATE public.automation_switches SET attribution=true WHERE id=1;
TRUNCATE rc_seen;
SELECT pg_temp.rc_assert(public.rerun_context_attribution(1000,NULL)=6,'machine rows remain eligible');
SELECT pg_temp.rc_assert((SELECT array_agg(id ORDER BY seq) FROM rc_seen WHERE id IN ('00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000015'))=ARRAY['00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000015']::uuid[],'machine rotation retained');
-- Do not wake resting/undecided rows or touch a row that holds a job.
UPDATE public.business_events SET attribution_status='unplaced',metadata='{"luna_outcome":"undecided"}' WHERE contact_id='rc-a';
UPDATE public.business_events SET attribution_status='pending_luna' WHERE contact_id='rc-b';
SELECT pg_temp.rc_assert(public.rerun_context_attribution(1000,NULL)=0,'resting and pending rows excluded');
-- Bounds exercise the actual cursor, not a source-text assertion.
INSERT INTO public.business_events(event_type,occurred_at,payload) SELECT 'client.reply',now(),'{}' FROM generate_series(1,1005);
SELECT pg_temp.rc_assert(public.rerun_context_attribution(NULL,NULL)=250,'null defaults to 250');
SELECT pg_temp.rc_assert(public.rerun_context_attribution(10000,NULL)=1000,'hard ceiling 1000');
ROLLBACK;

BEGIN;
CREATE FUNCTION pg_temp.rc_assert(ok boolean, message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'recheck contract: %', message; END IF; END $$;
UPDATE public.automation_switches SET all_stop=false, attribution=true WHERE id=1;
UPDATE public.feature_flags SET enabled=true WHERE flag_name='context_unlinked_rules_v1';
DO $$
DECLARE j uuid:=gen_random_uuid(); j2 uuid:=gen_random_uuid(); e public.business_events; eid uuid; before_mode text;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES
 (j,'00000000-0000-0000-0000-000000000001','quoted','fencing','RC-RECHECK-1','rc-real','2026-09-01');
 -- Simulate stored pre-rule bucket rows. Normal insert triggers remain enabled.
 FOREACH before_mode IN ARRAY ARRAY['live','backfill','relink',''] LOOP
  INSERT INTO public.business_events(source,event_type,payload,contact_id,provider_message_id,channel,direction,event_at,metadata)
  VALUES('ghl-webhook-receiver','client.reply','{"body":"Please confirm the fence quote","line":"fencing"}',
   'rc-real','ghl:rc-real-'||before_mode,'sms','inbound','2026-09-20',
   CASE WHEN before_mode='' THEN '{"kept":"yes"}'::jsonb ELSE jsonb_build_object('capture_mode',before_mode,'kept','yes') END) RETURNING id INTO eid;
  UPDATE public.business_events SET job_id=NULL,attribution_status='admin_bucket',attributed_at=NULL WHERE id=eid;
  PERFORM pg_temp.rc_assert(public.rerun_context_attribution(1,'rc-real')=1,'real ladder selected old reply');
  SELECT * INTO e FROM public.business_events WHERE id=eid;
  PERFORM pg_temp.rc_assert(e.job_id=j AND e.attributed_at IS NOT NULL,'real ladder binds');
  PERFORM pg_temp.rc_assert(e.metadata->>'capture_mode'=CASE WHEN before_mode='backfill' THEN 'backfill' ELSE 'relink' END,'history marker blocks listener reaction');
  PERFORM pg_temp.rc_assert(e.metadata->>'kept'='yes','metadata preserved');
  IF before_mode IN ('live','') THEN
   PERFORM pg_temp.rc_assert(e.metadata->'capture_mode_before'=CASE WHEN before_mode='' THEN 'null'::jsonb ELSE '"live"'::jsonb END,'prior mode recorded');
  END IF;
  PERFORM pg_temp.rc_assert(public.rerun_context_attribution(1,'rc-real')=0,'already-bound row excluded');
 END LOOP;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES
 (j2,'00000000-0000-0000-0000-000000000001','quoted','fencing','RC-RECHECK-2','rc-real','2026-09-02');
 INSERT INTO public.business_events(source,event_type,payload,contact_id,provider_message_id,channel,direction,event_at,metadata)
 VALUES('ghl-webhook-receiver','client.reply','{"body":"Which quote should I use?","line":"fencing"}',
  'rc-real','ghl:rc-pending','sms','inbound','2026-09-20','{"capture_mode":"live"}') RETURNING id INTO eid;
 UPDATE public.business_events SET job_id=NULL,attribution_status='admin_bucket',attributed_at=NULL WHERE id=eid;
 PERFORM public.rerun_context_attribution(1000,'rc-real');
 SELECT * INTO e FROM public.business_events WHERE id=eid;
 PERFORM pg_temp.rc_assert(e.attribution_status='pending_luna' AND e.job_id IS NULL,'stamp after ladder: preserve first ask instead of resting it');
 PERFORM pg_temp.rc_assert(e.metadata->>'capture_mode'='relink','queued placement is historical too');
 e:=public.attribute_context_event_with_luna(eid,j,0.95,'job');
 PERFORM pg_temp.rc_assert(e.job_id=j AND e.metadata->>'capture_mode'='relink','real Luna writer preserves relink');
END $$;
-- The full old today_pass row survives except its abandoned attribution marker.
INSERT INTO public.context_pass_days(run_date,status,attribution_done_at,bucket_done_at)
VALUES((now() AT TIME ZONE 'Australia/Perth')::date,'done',now(),now())
ON CONFLICT(run_date) DO UPDATE SET attribution_done_at=excluded.attribution_done_at,bucket_done_at=excluded.bucket_done_at;
SELECT pg_temp.rc_assert(public.context_core_status()->'today_pass'=(SELECT to_jsonb(p)-'attribution_done_at' FROM public.context_pass_days p WHERE run_date=(now() AT TIME ZONE 'Australia/Perth')::date),'today_pass omits only retired field');
SELECT pg_temp.rc_assert(public.context_pipeline_status()->'today_pass'=public.context_core_status()->'today_pass','composer publishes same status');
SELECT pg_temp.rc_assert((SELECT attribution_done_at IS NOT NULL FROM public.context_pass_days WHERE run_date=(now() AT TIME ZONE 'Australia/Perth')::date),'historical column kept');
DELETE FROM public.context_pass_days WHERE run_date=(now() AT TIME ZONE 'Australia/Perth')::date;
SELECT pg_temp.rc_assert(public.context_core_status()->'today_pass'='null'::jsonb,'absent day remains JSON null');
SELECT pg_temp.rc_assert(NOT has_function_privilege('anon','public.rerun_context_attribution(integer,text)','execute') AND NOT has_function_privilege('authenticated','public.rerun_context_attribution(integer,text)','execute') AND has_function_privilege('service_role','public.rerun_context_attribution(integer,text)','execute'),'rerun grants retained');
ROLLBACK;

BEGIN;
CREATE FUNCTION pg_temp.rc_assert(ok boolean, message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'recheck contract: %', message; END IF; END $$;
-- The new migration must be idempotent without moving any evidence.
CREATE TEMP TABLE rc_before AS SELECT id, to_jsonb(e) AS row FROM public.business_events e;
\ir ../../../migrations/20261014034549_context_recheck_messages_first.sql
SELECT pg_temp.rc_assert(NOT EXISTS(
 (SELECT id,to_jsonb(e) FROM public.business_events e EXCEPT SELECT * FROM rc_before)
 UNION ALL (SELECT * FROM rc_before EXCEPT SELECT id,to_jsonb(e) FROM public.business_events e)), 'migration changed evidence');
ROLLBACK;
