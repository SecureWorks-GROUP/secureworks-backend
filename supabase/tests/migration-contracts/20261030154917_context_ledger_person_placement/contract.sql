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

CREATE TEMP TABLE checks(name text,passed boolean);
CREATE FUNCTION pg_temp.prove(n text,p boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF p IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAILED: %',n; END IF; INSERT INTO checks VALUES(n,p);
END $$;
CREATE TEMP TABLE source_before AS SELECT id,job_id,payload FROM business_events WHERE source='cardev-contract';
DO $test$
DECLARE a uuid:='7e000000-0000-0000-0000-00000000000a'; b uuid:='7e000000-0000-0000-0000-00000000000b';
 staff uuid:='7e100000-0000-0000-0000-000000000001'; ev uuid; d jsonb; before jsonb; callid uuid:='7e200000-0000-0000-0000-000000000008'; tx uuid:='7e200000-0000-0000-0000-000000000009'; route text; mail uuid:='7e300000-0000-0000-0000-000000000001';
BEGIN
 DELETE FROM feature_flags WHERE flag_name='context_ledger_person_placement_v1';
 PERFORM pg_temp.prove('missing flag preserves original evidence',(SELECT count(*)=3 FROM context_ledger_evidence_rows(ARRAY[a],now()+interval '1 second')));
 SELECT jsonb_agg(to_jsonb(r) ORDER BY r.src_id) INTO before FROM context_ledger_evidence_rows(ARRAY[a,b],now()+interval '1 second') r;
 FOREACH ev IN ARRAY ARRAY['7e200000-0000-0000-0000-000000000001','7e200000-0000-0000-0000-000000000002','7e200000-0000-0000-0000-000000000003']::uuid[] LOOP
  PERFORM context_recon_record_decision(ev,context_recon_evidence_hash(ev),'split',ARRAY[a,b],'defect:no_identity',staff);
 END LOOP;
 ev:='7e200000-0000-0000-0000-000000000005';
 PERFORM context_recon_record_decision(ev,context_recon_evidence_hash(ev),'correct',ARRAY[b],'ambiguity:wrong_job',staff);
 PERFORM context_recon_record_decision('7e200000-0000-0000-0000-000000000006',context_recon_evidence_hash('7e200000-0000-0000-0000-000000000006'),'unrelated','{}'::uuid[],'ambiguity:not_a_job',staff);
 INSERT INTO feature_flags(flag_name,enabled) VALUES('context_ledger_person_placement_v1',false);
 PERFORM pg_temp.prove('off flag byte-preserves evidence after decisions',before=(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.src_id) FROM context_ledger_evidence_rows(ARRAY[a,b],now()+interval '1 second') r));
 d:=context_ledger_cite(b,jsonb_build_object('table','business_events','id',ev,'excerpt','Wrong job'));
 PERFORM pg_temp.prove('off flag preserves citation refusal',d->>'code'='citation_off_job');
 UPDATE feature_flags SET enabled=true WHERE flag_name='context_ledger_person_placement_v1';
 PERFORM pg_temp.prove('split and move reader agrees with card',NOT EXISTS(
  (SELECT job_id,event_id FROM context_job_card_events(ARRAY[a,b]) EXCEPT SELECT job_id,src_id FROM context_ledger_evidence_rows(ARRAY[a,b],now()+interval '1 second'))
  UNION ALL (SELECT job_id,src_id FROM context_ledger_evidence_rows(ARRAY[a,b],now()+interval '1 second') EXCEPT SELECT job_id,event_id FROM context_job_card_events(ARRAY[a,b]))));
 PERFORM pg_temp.prove('four evidence rows on each job',(SELECT count(*)=8 FROM context_ledger_evidence_rows(ARRAY[a,b],now()+interval '1 second')));
 PERFORM pg_temp.prove('placed rows are not also held',NOT EXISTS(SELECT 1 FROM context_ledger_held_rows(ARRAY[a,b],now()+interval '1 second') WHERE src_id IN ('7e200000-0000-0000-0000-000000000001','7e200000-0000-0000-0000-000000000002','7e200000-0000-0000-0000-000000000003')));
 PERFORM pg_temp.prove('person decision wakes moved evidence at decision time',(SELECT landed_at>=now() AND at<now()-interval '1 day' FROM context_ledger_evidence_rows(ARRAY[b],now()+interval '1 second') WHERE src_id=ev));
 PERFORM pg_temp.prove('historical as-of excludes future landing',NOT EXISTS(SELECT 1 FROM context_ledger_evidence_rows(ARRAY[b],now()-interval '1 second') WHERE src_id=ev));
 PERFORM pg_temp.prove('moved citation accepted on destination',(context_ledger_cite(b,jsonb_build_object('table','business_events','id',ev,'excerpt','Wrong job'))->>'ok')::boolean);
 PERFORM pg_temp.prove('moved citation refused on original',context_ledger_cite(a,jsonb_build_object('table','business_events','id',ev,'excerpt','Wrong job'))->>'code'='citation_off_job');
 PERFORM pg_temp.prove('unrelated citation refused',context_ledger_cite(a,jsonb_build_object('table','business_events','id','7e200000-0000-0000-0000-000000000006','excerpt','Not about a job'))->>'code'='citation_off_job');
 PERFORM pg_temp.prove('split citable on both jobs',(context_ledger_cite(a,'{"table":"business_events","id":"7e200000-0000-0000-0000-000000000001","excerpt":"Confirmed"}')->>'ok')::boolean AND (context_ledger_cite(b,'{"table":"business_events","id":"7e200000-0000-0000-0000-000000000001","excerpt":"Confirmed"}')->>'ok')::boolean);
 PERFORM pg_temp.prove('invented excerpt still refused',context_ledger_cite(b,jsonb_build_object('table','business_events','id',ev,'excerpt','The payment has been fully settled'))->>'code'='excerpt_not_verbatim');
 PERFORM pg_temp.prove('source rows and payload unchanged',NOT EXISTS(SELECT 1 FROM source_before s JOIN business_events e USING(id) WHERE s.job_id IS DISTINCT FROM e.job_id OR s.payload IS DISTINCT FROM e.payload));
 -- Four independent legacy copy keys cannot resurrect a decided source.
 FOREACH route IN ARRAY ARRAY['source','graph','payload','sender'] LOOP
  INSERT INTO inbox_events(id,job_id,from_email,subject,body_preview,received_at,processed_at,graph_message_id)
  VALUES(mail,b,'orders@supplier.example','Legacy supplier copy','Legacy preview differs from original',
    CASE WHEN route='sender' THEN '2026-10-08 09:10Z'::timestamptz ELSE '2026-10-08 00:00Z'::timestamptz END,'2026-10-08','legacy-placement-key');
  UPDATE business_events SET source_table=CASE WHEN route='source' THEN 'inbox_events' END,
   source_id=CASE WHEN route='source' THEN mail::text END,
   provider_message_id=CASE WHEN route='graph' THEN 'graph:legacy-placement-key' END,
   payload=(payload-'inbox_events_id')||CASE WHEN route='payload' THEN jsonb_build_object('inbox_events_id',mail::text) ELSE '{}'::jsonb END
  WHERE id='7e200000-0000-0000-0000-000000000001';
  PERFORM pg_temp.prove(route||' legacy copy not repeated in reader',NOT EXISTS(SELECT 1 FROM context_ledger_evidence_rows(ARRAY[b],now()+interval '1 second') WHERE src_table='inbox_events' AND src_id=mail));
  PERFORM pg_temp.prove(route||' legacy copy cannot bypass citation placement',context_ledger_cite(b,jsonb_build_object('table','inbox_events','id',mail,'excerpt','Legacy preview differs from original'))->>'code'='citation_not_admissible');
  DELETE FROM inbox_events WHERE id=mail;
 END LOOP;
 UPDATE business_events SET source_table=NULL,source_id=NULL,provider_message_id=NULL,payload=payload-'inbox_events_id' WHERE id='7e200000-0000-0000-0000-000000000001';
 -- Intrinsic invalid-source checks must survive a valid person decision.
 UPDATE business_events SET metadata=metadata||'{"retracted":true}' WHERE id=ev;
 PERFORM pg_temp.prove('retracted moved source neither evidence nor cite',NOT EXISTS(SELECT 1 FROM context_ledger_evidence_rows(ARRAY[b],now()+interval '1 second') WHERE src_id=ev) AND context_ledger_cite(b,jsonb_build_object('table','business_events','id',ev,'excerpt','Wrong job'))->>'code'='citation_not_admissible');
 UPDATE business_events SET metadata=(metadata-'retracted')||'{"duplicate_of":"7e200000-0000-0000-0000-000000000004"}' WHERE id=ev;
 PERFORM pg_temp.prove('duplicate moved source refused',context_ledger_cite(b,jsonb_build_object('table','business_events','id',ev,'excerpt','Wrong job'))->>'code'='citation_not_admissible');
 UPDATE business_events SET metadata=(metadata-'duplicate_of')||'{"written_as":"authenticated"}' WHERE id=ev;
 PERFORM pg_temp.prove('untrusted writer refused',context_ledger_cite(b,jsonb_build_object('table','business_events','id',ev,'excerpt','Wrong job'))->>'code'='citation_not_admissible');
 UPDATE business_events SET metadata=metadata-'written_as',payload=payload||'{"job_id":"7e000000-0000-0000-0000-00000000000c"}' WHERE id=ev;
 PERFORM pg_temp.prove('conflicting payload authority not erased',context_ledger_cite(b,jsonb_build_object('table','business_events','id',ev,'excerpt','Wrong job'))->>'code'='citation_not_admissible');
 UPDATE business_events SET payload=payload-'job_id' WHERE id=ev;
 -- A moved job_customer stamp is not portable; known supplier/staff roles are preserved.
 UPDATE business_events SET metadata=metadata||'{"party_roles":{"sender_role":"customer","recipient_role":"staff","counterpart_role":"customer","audience":"customer","basis":"job_customer"}}',event_type='client.reply',direction='inbound' WHERE id=ev;
 PERFORM pg_temp.prove('moved customer identity stays unknown',(context_ledger_cite(b,jsonb_build_object('table','business_events','id',ev,'excerpt','Wrong job'))->>'customer_sender')::boolean=false);
 PERFORM pg_temp.prove('reader agrees about unknown customer',(SELECT sender_role='unknown' AND recipient_role='staff' FROM context_ledger_evidence_rows(ARRAY[b],now()+interval '1 second') WHERE src_id=ev));
 -- Changed body invalidates the person decision and restores the existing card's ladder placement.
 UPDATE business_events SET payload=payload||'{"body":"New evidence needs another placement decision"}' WHERE id=ev;
 PERFORM pg_temp.prove('changed evidence invalidates move',NOT EXISTS(SELECT 1 FROM context_ledger_evidence_rows(ARRAY[b],now()+interval '1 second') WHERE src_id=ev) AND EXISTS(SELECT 1 FROM context_ledger_evidence_rows(ARRAY[a],now()+interval '1 second') WHERE src_id=ev));
 -- New call and transcript start on A with A's customer, then move independently.
 INSERT INTO business_events(id,event_type,source,channel,direction,occurred_at,event_at,payload,provider_message_id) VALUES
 (callid,'client.call_logged','reader-placement-fixture','call','inbound',now()-interval '2 days',now()-interval '2 days','{"body":"Synthetic call log"}','ghl:reader-placement-fixture'),
 (tx,'call.transcript_completed','reader-placement-fixture','call','inbound',now()-interval '2 days',now()-interval '2 days','{"transcript":"Synthetic customer confirms receipt","ghl_call_id":"reader-placement-fixture"}','ghltx:reader-placement-fixture');
 UPDATE business_events SET job_id=a,attribution_status='direct',attribution_confidence=1,contact_id='cardev-1',metadata=metadata||'{"party_roles":{"sender_role":"customer","counterpart_role":"customer","basis":"job_customer"}}' WHERE id IN(callid,tx);
 PERFORM context_recon_record_decision(tx,context_recon_evidence_hash(tx),'correct',ARRAY[b],'ambiguity:wrong_job',staff);
 PERFORM pg_temp.prove('transcript on other job cannot pair with old call',(SELECT has_transcript=false FROM context_ledger_evidence_rows(ARRAY[a],now()+interval '1 second') WHERE src_id=callid));
 PERFORM pg_temp.prove('moved transcript cannot close as new customer',coalesce((context_ledger_cite(b,jsonb_build_object('table','business_events','id',tx,'excerpt','Synthetic customer confirms receipt'))->>'customer_sender')::boolean,false)=false);
 PERFORM context_recon_record_decision(callid,context_recon_evidence_hash(callid),'correct',ARRAY[b],'ambiguity:wrong_job',staff);
 PERFORM pg_temp.prove('moved call pairs on destination',(SELECT has_transcript=true FROM context_ledger_evidence_rows(ARRAY[b],now()+interval '1 second') WHERE src_id=callid));
 PERFORM pg_temp.prove('paired moved call still does not establish new customer',(SELECT call_customer=false FROM context_ledger_evidence_rows(ARRAY[b],now()+interval '1 second') WHERE src_id=tx));
 PERFORM pg_temp.prove('pair no longer labelled on other job',context_ledger_row_elsewhere(b,'business_events',tx) IS DISTINCT FROM 'call_on_other_job');
 UPDATE jobs SET ghl_contact_id='cardev-1' WHERE id=b;
 PERFORM pg_temp.prove('independently matching destination CRM identity retained',(SELECT call_customer=true FROM context_ledger_evidence_rows(ARRAY[b],now()+interval '1 second') WHERE src_id=tx) AND (context_ledger_cite(b,jsonb_build_object('table','business_events','id',tx,'excerpt','Synthetic customer confirms receipt'))->>'customer_sender')::boolean);
 UPDATE jobs SET ghl_contact_id='cardev-2' WHERE id=b;
 UPDATE business_events SET metadata=jsonb_set(metadata,'{party_roles}','null'::jsonb) WHERE id=tx;
 PERFORM pg_temp.prove('null role stamp remains unknown without failing packet',EXISTS(SELECT 1 FROM context_ledger_evidence_rows(ARRAY[b],now()+interval '1 second') WHERE src_id=tx) AND NOT (context_ledger_cite(b,jsonb_build_object('table','business_events','id',tx,'excerpt','Synthetic customer confirms receipt'))->>'customer_sender')::boolean);

 PERFORM pg_temp.prove('browser cannot call projection',NOT has_function_privilege('authenticated','context_ledger_reader_events(uuid[])','EXECUTE') AND NOT has_function_privilege('anon','context_ledger_event_on_job(public.business_events,uuid)','EXECUTE'));
 PERFORM pg_temp.prove('service can read projection',has_function_privilege('service_role','context_ledger_reader_events(uuid[])','EXECUTE'));
END $test$;
-- The switch helper cannot silently enable behavior when its caller cannot read settings.
REVOKE SELECT ON public.feature_flags FROM service_role;
SET LOCAL ROLE service_role;
DO $$ BEGIN IF public.context_ledger_person_placement_enabled() IS DISTINCT FROM false THEN RAISE EXCEPTION 'unreadable switch enabled behavior'; END IF; END $$;
RESET ROLE;
SELECT pg_temp.prove('unreadable switch stays off',true);

SELECT jsonb_build_object('checked_at',now(),'checks',jsonb_agg(to_jsonb(checks)),'scope','actual local SQL, synthetic transaction rolled back; not production or model acceptance') FROM checks;
ROLLBACK;
