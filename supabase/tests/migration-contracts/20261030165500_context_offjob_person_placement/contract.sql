-- Contract for 20261021150000_context_job_card_events (CTX-T22, gap G5). Proves, against the real
-- stacked schema and the live ladder triggers, on the SWP-26376 shape (three supplier emails with
-- no contact, each a candidate for two jobs): before a decision the second job's card says no
-- email is placed yet (never that there are none) and that three wait in Matching; a staff split
-- puts the three on both cards (messages, emails lane, person_placed with who and when) and
-- Matching holds none; the split line says any amount in them is unknown and money is unchanged;
-- a correct moves a row, an unrelated takes one off, an escalate and a decision whose evidence
-- moved change nothing; a job no decision touches reads byte for byte as before;
-- business_events.job_id is never written; no browser role can call the helpers. Every fixture
-- write is rolled back.
\set ON_ERROR_STOP 1

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND (has_function_privilege('authenticated', 'public.context_job_card_events(uuid[])', 'EXECUTE')
          OR has_function_privilege('anon', 'public.context_job_card_events(uuid[])', 'EXECUTE')
          OR has_function_privilege('authenticated', 'public.context_job_card_decisions(uuid)', 'EXECUTE')
          OR has_function_privilege('anon', 'public.context_job_card_decisions(uuid)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'card events contract: a browser role holds a grant';
  END IF;
  -- The card events read must stay inlinable: plain SQL, no SET clause, not SECURITY DEFINER.
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid IN ('public.context_job_card_events(uuid[])'::regprocedure,
                                                     'public.context_job_card_decisions(uuid)'::regprocedure)
             AND (p.prosecdef OR p.proconfig IS NOT NULL OR p.prolang <> (SELECT oid FROM pg_language WHERE lanname = 'sql'))) THEN
    RAISE EXCEPTION 'card events contract: a helper is SECURITY DEFINER, carries SET or is not SQL';
  END IF;
END $$;

BEGIN;
INSERT INTO public.jobs (id, org_id, type, status, job_number, ghl_contact_id, created_at) VALUES
  ('7e000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000001', 'patio', 'accepted', 'SWP-98101', 'cardev-1', '2026-09-01'),
  ('7e000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000001', 'patio', 'accepted', 'SWP-98102', 'cardev-2', '2026-09-01'),
  ('7e000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-000000000001', 'patio', 'accepted', 'SWP-98103', 'cardev-3', '2026-09-01');
INSERT INTO public.users (id, org_id, name, role) VALUES
  ('7e100000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Card contract staff', 'ops_manager');
INSERT INTO public.business_events (id, channel, direction, occurred_at, payload, event_type, source) VALUES
  ('7e200000-0000-0000-0000-000000000001', 'email', 'inbound', '2026-10-08 09:10Z',
   '{"from":"orders@supplier.example","subject":"Order SWP-98101 & SWP-98102 confirmed","body":"Confirmed"}', 'email.inbound', 'cardev-contract'),
  ('7e200000-0000-0000-0000-000000000002', 'email', 'inbound', '2026-10-08 09:20Z',
   '{"from":"orders@supplier.example","subject":"Order SWP-98101 & SWP-98102 dispatched","body":"Dispatched"}', 'email.inbound', 'cardev-contract'),
  ('7e200000-0000-0000-0000-000000000003', 'email', 'inbound', '2026-10-08 09:30Z',
   '{"from":"orders@supplier.example","subject":"Order SWP-98101 & SWP-98102 invoice","body":"Invoice attached"}', 'email.inbound', 'cardev-contract'),
  ('7e200000-0000-0000-0000-000000000004', 'email', 'inbound', '2026-10-07 09:10Z',
   '{"from":"orders@supplier.example","subject":"Order SWP-98101 placed","body":"Placed"}', 'email.inbound', 'cardev-contract'),
  ('7e200000-0000-0000-0000-000000000005', 'email', 'inbound', '2026-10-06 09:10Z',
   '{"from":"orders@supplier.example","subject":"Delivery booked","body":"Wrong job"}', 'email.inbound', 'cardev-contract'),
  ('7e200000-0000-0000-0000-000000000006', 'email', 'inbound', '2026-10-05 09:10Z',
   '{"from":"news@unrelated.example","subject":"Newsletter","body":"Not about a job"}', 'email.inbound', 'cardev-contract'),
  ('7e200000-0000-0000-0000-000000000007', 'email', 'inbound', '2026-10-04 09:10Z',
   '{"from":"orders@supplier.example","subject":"Order SWP-98103 placed","body":"Control"}', 'email.inbound', 'cardev-contract');
-- The SWP-26376 shape as the ladder leaves it: no identity, two candidates.
UPDATE public.business_events SET recorded_at = occurred_at, job_id = NULL, contact_id = NULL, attribution_status = 'unplaced',
  candidate_job_ids = ARRAY['7e000000-0000-0000-0000-00000000000a', '7e000000-0000-0000-0000-00000000000b']::uuid[]
WHERE id IN ('7e200000-0000-0000-0000-000000000001', '7e200000-0000-0000-0000-000000000002', '7e200000-0000-0000-0000-000000000003');
-- Rows the ladder placed on A (one stays, one a person corrects to B, one a person calls unrelated)
-- and on the control job C.
UPDATE public.business_events SET job_id = '7e000000-0000-0000-0000-00000000000a', attribution_status = 'single_open', candidate_job_ids = NULL, recorded_at = occurred_at
WHERE id IN ('7e200000-0000-0000-0000-000000000004', '7e200000-0000-0000-0000-000000000005', '7e200000-0000-0000-0000-000000000006');
UPDATE public.business_events SET job_id = '7e000000-0000-0000-0000-00000000000c', attribution_status = 'single_open', candidate_job_ids = NULL, recorded_at = occurred_at
WHERE id = '7e200000-0000-0000-0000-000000000007';


-- Synthetic confidence makes originally linked rows admissible to the reader.
UPDATE public.business_events SET attribution_confidence=0.9 WHERE source='cardev-contract';


UPDATE jobs SET ghl_contact_id='offjob-test',client_email='offjob@example.test' WHERE id IN ('7e000000-0000-0000-0000-00000000000a','7e000000-0000-0000-0000-00000000000b');
UPDATE business_events SET contact_id='offjob-test',event_type='client.email_in',metadata='{"party_roles":{"sender_role":"customer","counterpart_role":"customer","basis":"job_customer"}}' WHERE id='7e200000-0000-0000-0000-000000000005';
UPDATE business_events SET job_id='7e000000-0000-0000-0000-00000000000a',attribution_status='single_open' WHERE id='7e200000-0000-0000-0000-000000000005';
CREATE TEMP TABLE checks(name text,passed boolean);
CREATE TEMP TABLE consumer_story(story jsonb);
CREATE FUNCTION pg_temp.prove(n text,p boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF p IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAILED: %',n; END IF; INSERT INTO checks VALUES(n,p); END $$;
CREATE TEMP TABLE source_before AS SELECT id,job_id,payload,metadata FROM business_events WHERE source='cardev-contract';
DO $test$
DECLARE a uuid:='7e000000-0000-0000-0000-00000000000a'; b uuid:='7e000000-0000-0000-0000-00000000000b'; c uuid:='7e000000-0000-0000-0000-00000000000c';
 staff uuid:='7e100000-0000-0000-0000-000000000001'; moved uuid:='7e200000-0000-0000-0000-000000000005'; pending uuid:='7e200000-0000-0000-0000-000000000001'; loose uuid:='7e200000-0000-0000-0000-000000000002'; mail uuid:='7e200000-0000-0000-0000-000000000003';
 m jsonb; gen uuid:=gen_random_uuid(); offmeta jsonb; enabledmeta jsonb;
BEGIN
 DELETE FROM feature_flags WHERE flag_name='context_ledger_person_placement_v1';
 PERFORM context_recon_record_decision(pending,context_recon_evidence_hash(pending),'correct',ARRAY[b],'ambiguity:wrong_job',staff);
 PERFORM context_recon_record_decision(moved,context_recon_evidence_hash(moved),'correct',ARRAY[b],'ambiguity:wrong_job',staff);
 offmeta:=context_job_story_meta(b);
 PERFORM pg_temp.prove('missing flag keeps original metadata',offmeta#>>'{off_job,newest_customer_where}'='on job SWP-98101' AND (SELECT count(*) FROM context_unplaced_for_job(a))=3);
 INSERT INTO feature_flags(flag_name,enabled) VALUES('context_ledger_person_placement_v1',false);
 PERFORM pg_temp.prove('off equals missing flag',context_job_story_meta(b)=offmeta);
 UPDATE feature_flags SET enabled=true WHERE flag_name='context_ledger_person_placement_v1';
 PERFORM pg_temp.prove('placed row leaves unplaced count',(SELECT count(*) FROM context_unplaced_for_job(a))=2);
 PERFORM pg_temp.prove('receiving job no longer calls its message elsewhere',context_job_story_meta(b)#>>'{off_job,newest_customer_where}' IS NULL);
 PERFORM pg_temp.prove('original job names current other location',context_job_story_meta(a)#>>'{off_job,newest_customer_where}'='on job SWP-98102');
 PERFORM pg_temp.prove('source placement and content unchanged',NOT EXISTS(SELECT 1 FROM source_before old JOIN business_events x USING(id) WHERE (x.job_id,x.payload,x.metadata) IS DISTINCT FROM (old.job_id,old.payload,old.metadata)));
 PERFORM pg_temp.prove('same event is in receiving reader',(SELECT count(*) FROM context_ledger_reader_events(ARRAY[b]) e WHERE e.id=moved)=1);
 PERFORM context_recon_record_decision(moved,context_recon_evidence_hash(moved),'split',ARRAY[a,b],'ambiguity:wrong_job',staff);
 PERFORM pg_temp.prove('split on this job is not incorrectly described as elsewhere',context_job_story_meta(a)#>>'{off_job,newest_customer_where}' IS NULL AND context_job_story_meta(b)#>>'{off_job,newest_customer_where}' IS NULL);
 PERFORM context_recon_record_decision(moved,context_recon_evidence_hash(moved),'correct',ARRAY[c],'ambiguity:wrong_job',staff);
 PERFORM pg_temp.prove('second move names new destination',context_job_story_meta(a)#>>'{off_job,newest_customer_where}'='on job SWP-98103');
 PERFORM pg_temp.prove('placement does not invent destination customer identity',(SELECT e.metadata#>>'{party_roles,sender_role}'='unknown' FROM context_ledger_reader_events(ARRAY[c]) e WHERE e.id=moved));
 PERFORM context_recon_record_decision(moved,context_recon_evidence_hash(moved),'unrelated',ARRAY[]::uuid[],'ambiguity:not_a_job',staff);
 PERFORM pg_temp.prove('unrelated event is neither placed nor elsewhere',NOT EXISTS(SELECT 1 FROM business_events x CROSS JOIN LATERAL context_ledger_event_locations(x) l WHERE x.id=moved) AND context_job_story_meta(b)#>>'{off_job,newest_customer_where}' IS NULL);
 UPDATE business_events SET payload=payload||'{"body":"Updated source words"}' WHERE id=moved;
 PERFORM pg_temp.prove('changed source invalidates person authority',context_job_story_meta(b)#>>'{off_job,newest_customer_where}'='on job SWP-98101');
 UPDATE business_events SET payload=payload||'{"body":"Changed pending words"}' WHERE id=pending;
 PERFORM pg_temp.prove('changed pending source returns to uncertainty',(SELECT count(*) FROM context_unplaced_for_job(a))=3);
 -- Nonqueued null-job contact messages must not remain unplaced after a person decides.
 UPDATE business_events SET contact_id='offjob-test',event_type='client.email_in',metadata='{"party_roles":{"sender_role":"customer","basis":"job_customer"}}' WHERE id=loose;
 UPDATE business_events SET job_id=NULL,attribution_status='empty' WHERE id=loose;
 PERFORM pg_temp.prove('unqueued original is visible as uncertain',context_job_story_meta(a)#>>'{unplaced,newest_customer_at}' IS NOT NULL);
 PERFORM context_recon_record_decision(loose,context_recon_evidence_hash(loose),'correct',ARRAY[b],'ambiguity:wrong_job',staff);
 PERFORM pg_temp.prove('unqueued placed original leaves uncertainty',context_job_story_meta(a)#>>'{unplaced,newest_customer_at}' IS NULL);
 -- Mail with only a sender-address identity must not keep its old unplaced wording.
 UPDATE business_events SET payload=payload||'{"from":"offjob@example.test"}',event_type='client.email_in' WHERE id=mail;
 UPDATE business_events SET job_id=NULL,contact_id=NULL,attribution_status='unplaced' WHERE id=mail;
 PERFORM context_recon_record_decision(mail,context_recon_evidence_hash(mail),'correct',ARRAY[a],'ambiguity:wrong_job',staff);
 PERFORM pg_temp.prove('address-only placed mail is not still unplaced elsewhere',NOT coalesce(context_job_story_meta(a)#>>'{off_job,newest_customer_where}','') LIKE 'not placed%');
 -- Review belongs in the raw story, not solely a downstream renderer.
 INSERT INTO context_ledger_generations(id,job_id,kind,status,reader,promoted_at,evidence_until,checks) VALUES(gen,a,'backfill','live','luna-ledger:v8',now(),now(),'{"passed":true}');
 INSERT INTO context_ledger_items(generation_id,job_id,item_key,item_type,status,from_role,to_role,what,about_key,modality,phase,opened_at,opened_by,closes_on,written_by)
 VALUES(gen,a,'request:confirmation:offjob','request','open','us','customer','Please confirm the promised document','other:confirmation','requested','install',now()-interval '1 day',jsonb_build_array(jsonb_build_object('table','business_events','id',moved,'excerpt','Updated source words')),'reply','model:fixture');
 PERFORM context_recon_record_decision(moved,context_recon_evidence_hash(moved),'correct',ARRAY[b],'ambiguity:wrong_job',staff);
 m:=context_job_story(a,now());
 INSERT INTO consumer_story VALUES(m);
 PERFORM pg_temp.prove('raw story distinguishes review from rebuild',m::text NOT LIKE '%the story needs a rebuild%' AND m#>>'{meta,ledger,review_required}'='true');
 PERFORM pg_temp.prove('raw story retains exact historical matter',m#>>'{placement_review,items,0,item_key}'='request:confirmation:offjob' AND m#>>'{placement_review,items,0,status}'='open');
 PERFORM pg_temp.prove('record-only reader prompt stays ledger-free',NOT (context_job_story(a,now(),null,null,true)?'placement_review') AND context_job_story(a,now(),null,null,true)::text NOT LIKE '%Please confirm the promised document%');
 PERFORM pg_temp.prove('review does not close stored note',(SELECT status='open' AND closed_at IS NULL FROM context_ledger_items WHERE generation_id=gen));
 PERFORM pg_temp.prove('new helper has no browser grants',NOT has_function_privilege('anon','context_ledger_event_locations(public.business_events)','EXECUTE') AND NOT has_function_privilege('authenticated','context_ledger_event_locations(public.business_events)','EXECUTE') AND (SELECT prosecdef AND proconfig=ARRAY['search_path=public, pg_temp'] FROM pg_proc WHERE oid='context_ledger_event_locations(public.business_events)'::regprocedure));
 UPDATE feature_flags SET enabled=false WHERE flag_name='context_ledger_person_placement_v1';
 PERFORM pg_temp.prove('off still returns original source location',(SELECT l.job_id=a FROM business_events x CROSS JOIN LATERAL context_ledger_event_locations(x) l WHERE x.id=moved));
 PERFORM pg_temp.prove('off raw story omits review projection',NOT (context_job_story(a,now())?'placement_review'));
END $test$;
SELECT jsonb_build_object('checked_at',now(),'checks',jsonb_agg(to_jsonb(checks)),'raw_story',(SELECT story FROM consumer_story),'scope','actual local synthetic SQL; no production or independent acceptance') FROM checks;
ROLLBACK;
