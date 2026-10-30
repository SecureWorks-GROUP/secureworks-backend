-- Actual Matching SQL and decision writer over synthetic history. No live decision.
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE matching_time_checks(name text,passed boolean);
CREATE TEMP TABLE matching_time_reads(phase text,job_items jsonb,daily_items jsonb);
CREATE FUNCTION pg_temp.prove(n text,p boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF p IS DISTINCT FROM true THEN RAISE EXCEPTION 'Matching source time: %',n;END IF;
 INSERT INTO matching_time_checks VALUES(n,p);
END $$;
DO $test$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001';j uuid:=gen_random_uuid();j2 uuid:=gen_random_uuid();
 staff uuid:=gen_random_uuid();ev uuid:=gen_random_uuid();unknown_ev uuid:=gen_random_uuid();plain_ev uuid:=gen_random_uuid();
 contact text:='matching-time-'||gen_random_uuid();message text:='matchingtime'||replace(gen_random_uuid()::text,'-','');
 unknown_message text:='unknownmatching'||replace(gen_random_uuid()::text,'-','');h text;new_h text;base text;d bigint;old_d bigint;b record;
 loaded timestamptz:='2026-09-24 23:15:01.424Z';original timestamptz:='2026-09-17 04:43:15.377Z';q jsonb;
BEGIN
 INSERT INTO organisations(id,name) VALUES(org,'Synthetic matching source organisation') ON CONFLICT(id) DO NOTHING;
 INSERT INTO jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at) VALUES
 (j,org,'accepted','fencing','SWF-MATCHTIME-1',contact,'2026-09-01'),(j2,org,'accepted','fencing','SWF-MATCHTIME-2',contact,'2026-09-01');
 INSERT INTO users(id,org_id,name,role) VALUES(staff,org,'Synthetic matching operator','ops_manager');
 INSERT INTO business_events(id,channel,direction,occurred_at,event_at,payload,event_type,source,provider_message_id) VALUES
 (ev,'sms','inbound',loaded,loaded,jsonb_build_object('body','Please check the repair date.','ghl_message_id',message),'client.reply','ghl_sms_cache_backfill','ghl:'||message),
 (unknown_ev,'sms','inbound',loaded,loaded,jsonb_build_object('body','The source time is unavailable.','ghl_message_id',unknown_message),'client.reply','ghl_sms_cache_backfill','ghl:'||unknown_message),
 (plain_ev,'sms','inbound','2026-10-20 04:00Z','2026-10-20 04:00Z','{"body":"Ordinary source text."}','client.reply','ghl-message-reconcile','ghl:plain'||message);
 UPDATE business_events SET contact_id=contact,job_id=NULL,attribution_status='unplaced',attribution_step=5,attribution_checked_at=now(),
 candidate_job_ids=ARRAY[j,j2],context_captured_at=now(),metadata=metadata||'{"party_roles":{"counterpart_role":"customer"}}' WHERE id IN(ev,unknown_ev,plain_ev);
 INSERT INTO context_crm_message_times(ghl_message_id,contact_id,crm_at) VALUES(message,contact,original);
 SELECT * INTO b FROM context_recon_job_items(j) WHERE event_id=ev;
 PERFORM pg_temp.prove('Find by job uses original CRM time not import clock',b.occurred_at=original);
 PERFORM pg_temp.prove('unknown CRM time is null not import clock',(SELECT occurred_at IS NULL FROM context_recon_job_items(j) WHERE event_id=unknown_ev));
 PERFORM pg_temp.prove('ordinary message time unchanged',(SELECT occurredred_at FROM (SELECT occurred_at AS occurredred_at FROM context_recon_job_items(j) WHERE event_id=plain_ev) x)='2026-10-20 04:00Z'::timestamptz);
 SELECT summary INTO q FROM context_recon_daily_list(now(),201) WHERE subject_id=ev;
 PERFORM pg_temp.prove('daily list uses same source day and second',(q->>'occurred_at')::timestamptz=date_trunc('second',original));
 PERFORM pg_temp.prove('daily unknown time stays explicit null',(SELECT summary ? 'occurred_at' AND summary->'occurred_at'='null'::jsonb FROM context_recon_daily_list(now(),201) WHERE subject_id=unknown_ev));
 PERFORM pg_temp.prove('capture and source records not rewritten',(SELECT occurred_at=loaded AND event_at=loaded FROM business_events WHERE id=ev));
 h:=b.shown_hash;
 SELECT context_recon_evidence_hash_of(channel,direction,occurred_at,contact_id,payload) INTO base FROM business_events WHERE id=ev;
 PERFORM pg_temp.prove('legacy source time participates in shown witness',h<>base AND h=context_recon_evidence_hash(ev));
 PERFORM pg_temp.prove('daily and job reads bind same witness',(SELECT evidence_hash=h FROM context_recon_daily_list(now(),201) WHERE subject_id=ev));
 PERFORM pg_temp.prove('ordinary message hash unchanged',(SELECT context_recon_evidence_hash(id)=context_recon_evidence_hash_of(channel,direction,occurred_at,contact_id,payload) FROM business_events WHERE id=plain_ev));
 INSERT INTO matching_time_reads SELECT 'before',jsonb_agg(to_jsonb(t)),(SELECT jsonb_agg(to_jsonb(l)) FROM context_recon_daily_list(now(),201) l WHERE subject_id IN(ev,unknown_ev,plain_ev)) FROM context_recon_job_items(j) t WHERE event_id IN(ev,unknown_ev,plain_ev);
 UPDATE context_crm_message_times SET crm_at=original+interval '1 day' WHERE ghl_message_id=message;
 new_h:=context_recon_evidence_hash(ev);
 PERFORM pg_temp.prove('source-only correction changes shown witness',new_h<>h);
 BEGIN PERFORM context_recon_record_decision(ev,h,'confirm',ARRAY[j],'ambiguity:several_candidates',staff);
  RAISE EXCEPTION 'stale time accepted'; EXCEPTION WHEN serialization_failure THEN NULL;END;
 PERFORM pg_temp.prove('stale time decision wrote nothing',NOT EXISTS(SELECT 1 FROM context_reconciliation_decisions WHERE subject_id=ev));
 d:=context_recon_record_decision(ev,new_h,'confirm',ARRAY[j],'ambiguity:several_candidates',staff);
 PERFORM pg_temp.prove('current decision stores base and source-time witness',(SELECT evidence_hash=base AND source_time_hash=(SELECT context_recon_source_time_hash(e) FROM business_events e WHERE e.id=ev) FROM context_reconciliation_decisions WHERE id=d));
 PERFORM pg_temp.prove('current decision places by person',(SELECT state='decided' FROM context_recon_decision_state(ev)) AND (SELECT job_ids=ARRAY[j] FROM context_recon_placement(ev)));
 UPDATE business_events SET metadata=metadata||'{"classification_only":"restamp"}' WHERE id=ev;
 PERFORM pg_temp.prove('classification change preserves decision',(SELECT state='decided' FROM context_recon_decision_state(ev)));
 UPDATE business_events SET job_id=j2,attribution_status='single_open' WHERE id=ev;
 PERFORM pg_temp.prove('time-aware person decision still guards ladder move',(SELECT job_id IS NULL AND metadata ? 'recon_held' FROM business_events WHERE id=ev) AND (SELECT job_ids=ARRAY[j] FROM context_recon_placement(ev)));
 UPDATE context_crm_message_times SET crm_at=original+interval '2 days' WHERE ghl_message_id=message;
 PERFORM pg_temp.prove('later source correction invalidates new time-aware decision',(SELECT state='evidence_changed' FROM context_recon_decision_state(ev)));
 PERFORM pg_temp.prove('changed evidence returns to Matching',(SELECT decision_state='evidence_changed' AND occurred_at=original+interval '2 days' FROM context_recon_job_items(j) WHERE event_id=ev));
 PERFORM pg_temp.prove('old placement not silently certain',NOT EXISTS(SELECT 1 FROM context_event_jobs(ev) WHERE placement='certain' AND by='person'));
 h:=context_recon_evidence_hash(ev);d:=context_recon_record_decision(ev,h,'split',ARRAY[j,j2],'ambiguity:several_candidates',staff);
 PERFORM pg_temp.prove('fresh split records both jobs',(SELECT job_ids=ARRAY[j,j2] FROM context_recon_placement(ev)));
 DELETE FROM context_crm_message_times WHERE ghl_message_id=message;
 PERFORM pg_temp.prove('loss of known source time invalidates new decision',(SELECT state='evidence_changed' FROM context_recon_decision_state(ev)) AND (SELECT occurred_at IS NULL FROM context_recon_job_items(j) WHERE event_id=ev));
 INSERT INTO matching_time_reads SELECT 'time_unknown',jsonb_agg(to_jsonb(t)),(SELECT jsonb_agg(to_jsonb(l)) FROM context_recon_daily_list(now(),201) l WHERE subject_id IN(ev,unknown_ev,plain_ev)) FROM context_recon_job_items(j) t WHERE event_id IN(ev,unknown_ev,plain_ev);
 -- Captured pre-upgrade decision shape: no time witness. Migration never rewrites it.
 SELECT context_recon_evidence_hash_of(channel,direction,occurred_at,contact_id,payload) INTO base FROM business_events WHERE id=unknown_ev;
 INSERT INTO context_reconciliation_decisions(subject_kind,subject_id,evidence_hash,action,job_ids,cause,by)
 VALUES('event',unknown_ev,base,'confirm',ARRAY[j],'ambiguity:several_candidates','person:'||staff) RETURNING id INTO old_d;
 INSERT INTO context_placement_links(decision_id,event_id,job_id) VALUES(old_d,unknown_ev,j);
 PERFORM pg_temp.prove('historical decision retains original contract',(SELECT state='decided' FROM context_recon_decision_state(unknown_ev)));
 INSERT INTO context_crm_message_times(ghl_message_id,contact_id,crm_at) VALUES(unknown_message,contact,original);
 PERFORM pg_temp.prove('recovering time does not erase historical placement',(SELECT state='decided' FROM context_recon_decision_state(unknown_ev)) AND (SELECT job_ids=ARRAY[j] FROM context_recon_placement(unknown_ev)));
 UPDATE business_events SET job_id=j2,attribution_status='single_open' WHERE id=unknown_ev;
 PERFORM pg_temp.prove('historical decision still guards ladder move',(SELECT job_id IS NULL AND metadata ? 'recon_held' FROM business_events WHERE id=unknown_ev));
 UPDATE business_events SET payload=payload||'{"body":"Changed original words."}' WHERE id=unknown_ev;
 PERFORM pg_temp.prove('historical changed words remain stale',(SELECT state='evidence_changed' FROM context_recon_decision_state(unknown_ev)));
 PERFORM pg_temp.prove('time helper grants stay service only',has_function_privilege('service_role','context_recon_source_at(business_events)','EXECUTE') AND NOT has_function_privilege('anon','context_recon_source_at(business_events)','EXECUTE') AND NOT has_function_privilege('authenticated','context_recon_source_time_hash(business_events)','EXECUTE'));
END $test$;
SELECT jsonb_build_object('count',(SELECT count(*) FROM matching_time_checks),'checks',(SELECT jsonb_agg(to_jsonb(c)) FROM matching_time_checks c),'snapshots',(SELECT jsonb_agg(to_jsonb(s)) FROM matching_time_reads s),'scope','synthetic actual SQL and writer, no live/staff/independent acceptance');
ROLLBACK;
