-- Real PostgreSQL behavioural checks; all rows roll back at the end.
BEGIN;
CREATE FUNCTION pg_temp.assert_luna(ok boolean, message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION '%', message; END IF; END $$;
CREATE FUNCTION pg_temp.luna_fact(src jsonb, tab text, fid text, body text DEFAULT 'source excerpt') RETURNS jsonb
LANGUAGE sql AS $$ SELECT jsonb_build_object(
  'id',fid,'job_id',src->>'job_id','kind','note','correlation_id',NULL,
  'value',jsonb_build_object('text',body,'source_refs',jsonb_build_array(jsonb_build_object('table',tab,'id',src->>'id'))),
  'provenance',jsonb_build_object('extractor','context-luna-subscription:v1','writer_role','classifier','untrusted',false,
    'source_event_ids',jsonb_build_array(src->>'id'),'extracted_at','2026-09-10T00:00:00Z',
    'safety',jsonb_build_object('memory_trusted',true,'action_safe',false,'state_change_safe',false,'outbound_safe',false))) $$;
CREATE FUNCTION pg_temp.reject_luna_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.fact_id='33333333-0000-4000-8000-000000000012'::uuid THEN
  RAISE EXCEPTION 'synthetic private provider text must not leak';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reject_luna_receipt BEFORE INSERT ON public.luna_context_source_revisions
 FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_luna_receipt();

INSERT INTO public.jobs (id,org_id,status,type,job_number,ghl_contact_id) VALUES
 ('11111111-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000001','new','patio','LUNA-CONTRACT-1','luna-contact'),
 ('11111111-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000001','new','patio','LUNA-CONTRACT-2',NULL);
INSERT INTO public.business_events (id,job_id,payload,match_status,match_method) SELECT
 ('22222222-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
 '11111111-0000-4000-8000-000000000001'::uuid, jsonb_build_object('text','original ' || n),'matched','direct_job_id'
 FROM generate_series(1,7) n;
INSERT INTO public.inbox_events (id,job_id,metadata,body_preview) VALUES
 ('22222222-0000-4000-8000-000000000008','11111111-0000-4000-8000-000000000001','{"match_confidence":"high","matched_via":"job_ref:fixture"}','mail evidence');
INSERT INTO public.job_events (id,job_id,detail_json) VALUES
 ('22222222-0000-4000-8000-000000000009','11111111-0000-4000-8000-000000000001','{"text":"native job note"}');

DO $$
DECLARE
 s jsonb; old_s jsonb; other_s jsonb; f jsonb; original jsonb; r jsonb; altered jsonb; tab text; source_id text;
 a constant text := '33333333-0000-4000-8000-000000000001';
 b constant text := '33333333-0000-4000-8000-000000000002';
 c constant text := '33333333-0000-4000-8000-000000000003';
BEGIN
 -- Actual API roles: execute is not publicly available; service role is invoker.
 PERFORM pg_temp.assert_luna(NOT has_function_privilege('anon','public.persist_luna_context_revision(text,text,jsonb,text,jsonb)','EXECUTE'),'anon must not execute');
 PERFORM pg_temp.assert_luna(NOT has_function_privilege('authenticated','public.persist_luna_context_revision(text,text,jsonb,text,jsonb)','EXECUTE'),'authenticated must not execute');
 PERFORM pg_temp.assert_luna(has_function_privilege('service_role','public.persist_luna_context_revision(text,text,jsonb,text,jsonb)','EXECUTE'),'service role execute required');
 PERFORM pg_temp.assert_luna(NOT (SELECT prosecdef FROM pg_proc WHERE oid='public.persist_luna_context_revision(text,text,jsonb,text,jsonb)'::regprocedure),'must be invoker');
 PERFORM pg_temp.assert_luna((SELECT proconfig @> ARRAY['search_path=pg_catalog'] FROM pg_proc WHERE oid='public.persist_luna_context_revision(text,text,jsonb,text,jsonb)'::regprocedure),'fixed search path required');
 PERFORM pg_temp.assert_luna(NOT has_table_privilege('authenticated','public.luna_context_source_revisions','SELECT'),'revision ledger must remain private');
 SELECT to_jsonb(e) INTO s FROM public.business_events e WHERE id='22222222-0000-4000-8000-000000000001';
 f := pg_temp.luna_fact(s,'business_events',a);
 SET LOCAL ROLE service_role;
 r := public.persist_luna_context_revision('business_events',s->>'id',s,'job_context',f);
 RESET ROLE;
 PERFORM pg_temp.assert_luna(r->>'outcome'='inserted','initial insert');
 SELECT to_jsonb(x) INTO original FROM public.job_context x WHERE id=a::uuid;
 r := public.persist_luna_context_revision('business_events',s->>'id',s,'job_context',f);
 PERFORM pg_temp.assert_luna(r->>'outcome'='idempotent','same revision replay');
 PERFORM pg_temp.assert_luna((SELECT to_jsonb(x)=original FROM public.job_context x WHERE id=a::uuid),'replay must not mutate row');

 -- Independent source and non-Luna row survive correction of source 1.
 SELECT to_jsonb(e) INTO other_s FROM public.business_events e WHERE id='22222222-0000-4000-8000-000000000002';
 PERFORM public.persist_luna_context_revision('business_events',other_s->>'id',other_s,'job_context',pg_temp.luna_fact(other_s,'business_events',c));
 INSERT INTO public.job_context (id,job_id,kind,value,provenance) VALUES
  ('33333333-0000-4000-8000-000000000004',(s->>'job_id')::uuid,'note',f->'value','{"extractor":"human","safety":{"memory_trusted":true}}');
 old_s := s;
 UPDATE public.business_events SET payload='{"text":"corrected"}',job_id='11111111-0000-4000-8000-000000000002' WHERE id=(s->>'id')::uuid;
 SELECT to_jsonb(e) INTO s FROM public.business_events e WHERE id=(old_s->>'id')::uuid;
 f := pg_temp.luna_fact(s,'business_events',b) || '{"kind":"pending_action","expires_at":"2026-10-01T00:00:00Z"}'::jsonb;
 r := public.persist_luna_context_revision('business_events',s->>'id',s,'job_temporary_context',f);
 PERFORM pg_temp.assert_luna(r->>'outcome'='inserted','store-switch correction');
 PERFORM pg_temp.assert_luna((SELECT provenance->>'lifecycle'='superseded' AND provenance#>>'{safety,memory_trusted}'='false'
   AND provenance->>'superseded_by'=b AND value=original->'value' FROM public.job_context WHERE id=a::uuid),'old-job fact retired without changing its value');
 PERFORM pg_temp.assert_luna((SELECT provenance#>>'{safety,memory_trusted}'='true' FROM public.job_context WHERE id=c::uuid),'independent source preserved');
 PERFORM pg_temp.assert_luna((SELECT provenance->>'extractor'='human' AND provenance#>>'{safety,memory_trusted}'='true' FROM public.job_context WHERE id='33333333-0000-4000-8000-000000000004'),'human source preserved');
 BEGIN
  PERFORM public.persist_luna_context_revision('business_events',old_s->>'id',old_s,'job_context',pg_temp.luna_fact(old_s,'business_events',a));
  RAISE EXCEPTION 'expected stale replay refusal';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'luna_source_revision_stale' THEN RAISE; END IF; END;

 -- Human correction to an already registered fact is preserved and held.
 UPDATE public.job_temporary_context SET value=jsonb_set(value,'{text}','"human correction"') WHERE id=b::uuid;
 SELECT to_jsonb(x) INTO original FROM public.job_temporary_context x WHERE id=b::uuid;
 r := public.persist_luna_context_revision('business_events',s->>'id',s,'job_temporary_context',f);
 PERFORM pg_temp.assert_luna(r->>'outcome'='held','human edit must hold');
 PERFORM pg_temp.assert_luna((SELECT to_jsonb(x)=original FROM public.job_temporary_context x WHERE id=b::uuid),'human edit must remain byte-for-byte');

 -- Explicit ambiguity can retract previous rows but cannot insert new context.
 UPDATE public.business_events SET match_status='ambiguous' WHERE id=(s->>'id')::uuid;
 SELECT to_jsonb(e) INTO s FROM public.business_events e WHERE id=(old_s->>'id')::uuid;
 BEGIN
  PERFORM public.persist_luna_context_revision('business_events',s->>'id',s,'job_temporary_context',f);
  RAISE EXCEPTION 'expected ambiguous refusal';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'luna_source_attribution_rejected' THEN RAISE; END IF; END;
 r := public.persist_luna_context_revision('business_events',s->>'id',s,NULL,NULL);
 PERFORM pg_temp.assert_luna(r->>'outcome'='retracted' AND r->'fact_id'='null'::jsonb,'retraction result');
 PERFORM pg_temp.assert_luna((SELECT provenance->>'lifecycle'='retracted' AND provenance#>>'{safety,memory_trusted}'='false' FROM public.job_temporary_context WHERE id=b::uuid),'temporary fact retracted');

 -- A zero-fact tombstone also blocks later fact creation for the same snapshot.
 SELECT to_jsonb(e) INTO s FROM public.business_events e WHERE id='22222222-0000-4000-8000-000000000003';
 r := public.persist_luna_context_revision('business_events',s->>'id',s,NULL,NULL);
 PERFORM pg_temp.assert_luna(r->>'outcome'='retracted','empty-source tombstone');
 r := public.persist_luna_context_revision('business_events',s->>'id',s,'job_context',pg_temp.luna_fact(s,'business_events','33333333-0000-4000-8000-000000000005'));
 PERFORM pg_temp.assert_luna(r->>'outcome'='held','tombstone cannot resurrect');
 PERFORM pg_temp.assert_luna(NOT EXISTS (SELECT 1 FROM public.job_context WHERE id='33333333-0000-4000-8000-000000000005'),'no resurrected row');

 -- Pre-RPC stable fact adoption changes neither its value nor provenance.
 SELECT to_jsonb(e) INTO s FROM public.business_events e WHERE id='22222222-0000-4000-8000-000000000004';
 f := pg_temp.luna_fact(s,'business_events','33333333-0000-4000-8000-000000000006');
 INSERT INTO public.job_context (id,job_id,kind,value,provenance,correlation_id)
  VALUES ((f->>'id')::uuid,(f->>'job_id')::uuid,f->>'kind',f->'value',f->'provenance',NULL);
 SELECT to_jsonb(x) INTO original FROM public.job_context x WHERE id=(f->>'id')::uuid;
 r := public.persist_luna_context_revision('business_events',s->>'id',s,'job_context',f);
 PERFORM pg_temp.assert_luna(r->>'outcome'='idempotent','adopt retained pre-RPC canary');
 PERFORM pg_temp.assert_luna((SELECT to_jsonb(x)=original FROM public.job_context x WHERE id=(f->>'id')::uuid),'adopt must preserve entire row');

 -- A pre-RPC human edit and pre-RPC retraction must not be adopted/restored.
 SELECT to_jsonb(e) INTO s FROM public.business_events e WHERE id='22222222-0000-4000-8000-000000000005';
 f := pg_temp.luna_fact(s,'business_events','33333333-0000-4000-8000-000000000007');
 INSERT INTO public.job_context (id,job_id,kind,value,provenance)
  VALUES ((f->>'id')::uuid,(f->>'job_id')::uuid,f->>'kind',jsonb_set(f->'value','{text}','"human edit"'),f->'provenance');
 r := public.persist_luna_context_revision('business_events',s->>'id',s,'job_context',f);
 PERFORM pg_temp.assert_luna(r->>'outcome'='held','pre-RPC human edit');
 UPDATE public.job_context SET value=f->'value',provenance=(f->'provenance') || '{"lifecycle":"retracted"}'::jsonb WHERE id=(f->>'id')::uuid;
 r := public.persist_luna_context_revision('business_events',s->>'id',s,'job_context',f);
 PERFORM pg_temp.assert_luna(r->>'outcome'='held','pre-RPC retracted fact');

 -- Contact-only binding can become ambiguous without changing source snapshot.
 UPDATE public.business_events SET match_method='contact_id',contact_id='luna-contact' WHERE id='22222222-0000-4000-8000-000000000006';
 SELECT to_jsonb(e) INTO s FROM public.business_events e WHERE id='22222222-0000-4000-8000-000000000006';
 f := pg_temp.luna_fact(s,'business_events','33333333-0000-4000-8000-000000000008');
 UPDATE public.jobs SET ghl_contact_id='luna-contact' WHERE id='11111111-0000-4000-8000-000000000002';
 BEGIN
  PERFORM public.persist_luna_context_revision('business_events',s->>'id',s,'job_context',f);
  RAISE EXCEPTION 'expected jobs contact ambiguity';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'luna_source_attribution_ambiguous' THEN RAISE; END IF; END;
 UPDATE public.jobs SET ghl_contact_id=NULL WHERE id='11111111-0000-4000-8000-000000000002';
 INSERT INTO public.contact_matches (job_id,ghl_contact_id) VALUES ('11111111-0000-4000-8000-000000000002','luna-contact');
 BEGIN
  PERFORM public.persist_luna_context_revision('business_events',s->>'id',s,'job_context',f);
  RAISE EXCEPTION 'expected contact_matches ambiguity';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'luna_source_attribution_ambiguous' THEN RAISE; END IF; END;
 DELETE FROM public.contact_matches WHERE ghl_contact_id='luna-contact';
 r := public.persist_luna_context_revision('business_events',s->>'id',s,'job_context',f);
 PERFORM pg_temp.assert_luna(r->>'outcome'='inserted','unambiguous contact binding');
 -- Other relations can revoke attribution while this exact source is unchanged.
 UPDATE public.jobs SET ghl_contact_id='luna-contact' WHERE id='11111111-0000-4000-8000-000000000002';
 r := public.persist_luna_context_revision('business_events',s->>'id',s,NULL,NULL);
 PERFORM pg_temp.assert_luna(r->>'outcome'='retracted','same revision ambiguity must retract');
 PERFORM pg_temp.assert_luna((SELECT provenance->>'lifecycle'='retracted' AND provenance#>>'{safety,memory_trusted}'='false'
   FROM public.job_context WHERE id=(f->>'id')::uuid),'same revision fact retired');
 UPDATE public.jobs SET ghl_contact_id=NULL WHERE id='11111111-0000-4000-8000-000000000002';
 r := public.persist_luna_context_revision('business_events',s->>'id',s,'job_context',f);
 PERFORM pg_temp.assert_luna(r->>'outcome'='held','restored contact uniqueness must not resurrect tombstone');
 r := public.persist_luna_context_revision('business_events',s->>'id',s,NULL,NULL);
 PERFORM pg_temp.assert_luna(r->>'outcome'='retracted','repeated retraction is idempotent');

 -- A failure after both fact insertion and retirement rolls everything back.
 SELECT to_jsonb(e) INTO s FROM public.business_events e WHERE id='22222222-0000-4000-8000-000000000007';
 f := pg_temp.luna_fact(s,'business_events','33333333-0000-4000-8000-000000000011');
 PERFORM public.persist_luna_context_revision('business_events',s->>'id',s,'job_context',f);
 SELECT to_jsonb(x) INTO original FROM public.job_context x WHERE id=(f->>'id')::uuid;
 UPDATE public.business_events SET payload='{"text":"new revision, receipt failure"}' WHERE id=(s->>'id')::uuid;
 SELECT to_jsonb(e) INTO s FROM public.business_events e WHERE id='22222222-0000-4000-8000-000000000007';
 BEGIN
  PERFORM public.persist_luna_context_revision('business_events',s->>'id',s,'job_context',
    pg_temp.luna_fact(s,'business_events','33333333-0000-4000-8000-000000000012'));
  RAISE EXCEPTION 'expected receipt persistence failure';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'luna_context_revision_failed' THEN RAISE; END IF; END;
 PERFORM pg_temp.assert_luna((SELECT to_jsonb(x)=original FROM public.job_context x WHERE id=(f->>'id')::uuid),'receipt failure must roll back supersession');
 PERFORM pg_temp.assert_luna(NOT EXISTS (SELECT 1 FROM public.job_context WHERE id='33333333-0000-4000-8000-000000000012'),'receipt failure must roll back insert');
 PERFORM pg_temp.assert_luna((SELECT count(*)=1 AND bool_and(lifecycle='active') FROM public.luna_context_source_revisions WHERE source_id=(s->>'id')::uuid),'receipt failure must roll back revision lifecycle');

 -- All source adapters, identity refusal and table allowlist use the same CAS.
 FOREACH tab IN ARRAY ARRAY['inbox_events','job_events'] LOOP
  EXECUTE format('SELECT to_jsonb(e) FROM public.%I e LIMIT 1',tab) INTO s;
  f := pg_temp.luna_fact(s,tab,CASE WHEN tab='inbox_events' THEN '33333333-0000-4000-8000-000000000009' ELSE '33333333-0000-4000-8000-000000000010' END);
  r := public.persist_luna_context_revision(tab,s->>'id',s,'job_context',f);
  PERFORM pg_temp.assert_luna(r->>'outcome'='inserted','source adapter ' || tab);
 END LOOP;
 BEGIN
  PERFORM public.persist_luna_context_revision('job_events; DROP TABLE jobs',s->>'id',s,'job_context',f);
  RAISE EXCEPTION 'expected source table refusal';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'luna_source_identity_invalid' THEN RAISE; END IF; END;
 BEGIN
  PERFORM public.persist_luna_context_revision('job_events',s->>'id',s,'job_context',jsonb_set(f,'{job_id}','"11111111-0000-4000-8000-000000000002"'));
  RAISE EXCEPTION 'expected wrong job refusal';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'luna_fact_source_mismatch' THEN RAISE; END IF; END;
 BEGIN
  PERFORM public.persist_luna_context_revision('job_events',s->>'id',s,'job_context',jsonb_set(f,'{provenance,extractor}','"human"'));
  RAISE EXCEPTION 'expected wrong extractor refusal';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'luna_fact_source_mismatch' THEN RAISE; END IF; END;
 RAISE NOTICE 'Luna revision contracts: correction/store/job switch, replay, human edits, tombstones, source adapters, attribution and ACL passed';
END $$;
ROLLBACK;
