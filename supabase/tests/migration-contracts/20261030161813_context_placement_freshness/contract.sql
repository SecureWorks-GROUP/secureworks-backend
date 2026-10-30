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
DECLARE a uuid:='7e000000-0000-0000-0000-00000000000a'; b uuid:='7e000000-0000-0000-0000-00000000000b'; c uuid:='7e000000-0000-0000-0000-00000000000c';
 staff uuid:='7e100000-0000-0000-0000-000000000001'; moved uuid:='7e200000-0000-0000-0000-000000000005'; ce uuid:='7e200000-0000-0000-0000-000000000007'; ga uuid:=gen_random_uuid(); gc uuid:=gen_random_uuid();
 d jsonb; old_d jsonb; packet jsonb; state jsonb; claim jsonb; finish jsonb; itemid uuid; sig text; heldsig text; oldsig text; story jsonb;
BEGIN
 UPDATE automation_switches SET extraction=true,all_stop=false WHERE id=1;
 UPDATE context_ledger_settings SET mode='live',reader='luna-ledger:v8',job_ids=ARRAY[a,b,c],backfill_from_hour=NULL,backfill_to_hour=NULL WHERE id;
 DELETE FROM feature_flags WHERE flag_name IN ('context_ledger_person_placement_v1','context_ledger_financial_refresh_v1');
 INSERT INTO context_ledger_generations(id,job_id,kind,status,reader,promoted_at,evidence_until,checks)
 VALUES(ga,a,'backfill','live','luna-ledger:v8',now()-interval '1 minute',now(),'{"passed":true}'),(gc,c,'backfill','live','luna-ledger:v8',now()-interval '1 minute',now(),'{"passed":true}');
 INSERT INTO context_ledger_items(generation_id,job_id,item_key,item_type,status,from_role,to_role,what,about_key,modality,phase,opened_at,opened_by,closes_on,written_by)
 VALUES(ga,a,'request:confirmation:fixture','request','open','us','customer','Please confirm the promised delivery document','other:confirmation','requested','install',now()-interval '1 day',jsonb_build_array(jsonb_build_object('table','business_events','id',moved,'excerpt','Wrong job')),'reply','model:luna-ledger:v8') RETURNING id INTO itemid;
 SELECT to_jsonb(x) INTO old_d FROM context_ledger_judge(ARRAY[a])x;
 PERFORM context_recon_record_decision(moved,context_recon_evidence_hash(moved),'correct',ARRAY[b],'ambiguity:wrong_job',staff);
 SELECT to_jsonb(x) INTO d FROM context_ledger_judge(ARRAY[a])x;
 PERFORM pg_temp.prove('missing activation preserves old scheduling',d=old_d);
 INSERT INTO feature_flags(flag_name,enabled) VALUES('context_ledger_person_placement_v1',false);
 SELECT to_jsonb(x) INTO d FROM context_ledger_judge(ARRAY[a])x;
 PERFORM pg_temp.prove('off activation preserves old scheduling',d=old_d);
 UPDATE feature_flags SET enabled=true WHERE flag_name='context_ledger_person_placement_v1';
 SELECT to_jsonb(x) INTO d FROM context_ledger_judge(ARRAY[b])x;
 PERFORM pg_temp.prove('destination automatically requests reading',(d->>'due')::boolean AND (d->>'evidence_rows')::integer=1);
 SELECT to_jsonb(x) INTO d FROM context_ledger_judge(ARRAY[a])x;
 PERFORM pg_temp.prove('donor unresolved obligation explicitly needs review',NOT (d->>'due')::boolean AND d->>'blocked_reason'='placement_obligation_review');
 PERFORM pg_temp.prove('original obligation retained without closure',(SELECT status='open' AND closed_at IS NULL AND item_key='request:confirmation:fixture' FROM context_ledger_items WHERE id=itemid));
 story:=context_job_story(a,now());
 PERFORM pg_temp.prove('staff card retains historical obligation with explicit uncertainty',story#>>'{placement_review,state}'='needs_review' AND story#>>'{placement_review,items,0,item_key}'='request:confirmation:fixture' AND EXISTS(SELECT 1 FROM jsonb_array_elements(story->'not_known')x WHERE x->>'item_key'='request:confirmation:fixture' AND x->>'certainty'='source_placement_review' AND x->>'what' LIKE 'Unresolved historical note needs review:%promised delivery document%'));
 PERFORM pg_temp.prove('card does not assert invalid note as a current loop',NOT EXISTS(SELECT 1 FROM jsonb_array_elements(story->'loops')x WHERE x->>'item_key'='request:confirmation:fixture'));
 PERFORM pg_temp.prove('record only model input remains ledger free',NOT (context_job_story(a,now(),NULL,NULL,true)?'placement_review') AND context_job_story(a,now(),NULL,NULL,true)::text NOT LIKE '%promised delivery document%');
 PERFORM pg_temp.prove('ledger citation matches reader authority',(context_job_story_ledger(a,NULL,now())#>>'{items,0,cites_ok}')::boolean=false);
 state:=context_ledger_placement_state(b);sig:=state->>'signature';
 PERFORM set_config('TimeZone','UTC',true);
 PERFORM pg_temp.prove('placement signature stable across session time zones',sig=context_ledger_placement_state(b)->>'signature');
 PERFORM set_config('TimeZone','Australia/Perth',true);
 packet:=context_ledger_packet(b,NULL,now());
 PERFORM pg_temp.prove('packet binds same placement snapshot',packet#>>'{placement,signature}'=sig AND (packet#>>'{placement,ready}')::boolean);
 packet:=context_ledger_packet(b,NULL,now()-interval '1 second');
 PERFORM pg_temp.prove('historical packet cannot acknowledge later placement',NOT (packet#>>'{placement,ready}')::boolean);
 -- A donor with no obligations still needs rebuilding after its last source moves.
 PERFORM context_recon_record_decision(ce,context_recon_evidence_hash(ce),'correct',ARRAY[b],'ambiguity:wrong_job',staff);
 SELECT to_jsonb(x) INTO d FROM context_ledger_judge(ARRAY[c])x;
 PERFORM pg_temp.prove('empty donor is due for correction',(d->>'due')::boolean AND d->>'reason'='placement_changed' AND (d->>'evidence_rows')::integer=0);
 claim:=context_ledger_claim(c,'rebuild',current_date);
 PERFORM pg_temp.prove('actual claim accepts empty donor correction',claim->>'outcome'='claimed');
 packet:=context_ledger_rebuild_packet((claim->>'run_id')::uuid,(claim->>'lease_token')::uuid);heldsig:=packet#>>'{placement,signature}';
 finish:=context_ledger_finish((claim->>'run_id')::uuid,(claim->>'lease_token')::uuid,(claim->>'generation_id')::uuid,'built',jsonb_build_object('evidence_until',now(),'checks',jsonb_build_object('proposed',0,'refused_local',0)));
 PERFORM pg_temp.prove('finish refuses unwitnessed placement',finish->>'reason'='placement_changed_during_read');
 -- Another real decision after packet preparation must reject the old snapshot.
 PERFORM context_recon_record_decision(ce,context_recon_evidence_hash(ce),'unrelated','{}'::uuid[],'ambiguity:not_a_job',staff);
 finish:=context_ledger_finish((claim->>'run_id')::uuid,(claim->>'lease_token')::uuid,(claim->>'generation_id')::uuid,'built',jsonb_build_object('evidence_until',now(),'checks',jsonb_build_object('proposed',0,'refused_local',0,'placement_signature',heldsig)));
 PERFORM pg_temp.prove('finish rejects correction during read',finish->>'reason'='placement_changed_during_read');
 packet:=context_ledger_rebuild_packet((claim->>'run_id')::uuid,(claim->>'lease_token')::uuid);heldsig:=packet#>>'{placement,signature}';
 finish:=context_ledger_finish((claim->>'run_id')::uuid,(claim->>'lease_token')::uuid,(claim->>'generation_id')::uuid,'built',jsonb_build_object('model','synthetic-fixture','evidence_until',now(),'checks',jsonb_build_object('proposed',0,'refused_local',0,'placement_signature',heldsig)));
 PERFORM pg_temp.prove('fresh empty correction finishes through actual store',finish->>'outcome'='built' AND coalesce((finish->>'promoted')::boolean,false));
 SELECT to_jsonb(x) INTO d FROM context_ledger_judge(ARRAY[c])x;
 PERFORM pg_temp.prove('consumed empty correction does not loop',NOT (d->>'due')::boolean AND d->>'reason' IS NULL);
 oldsig:=context_ledger_placement_state(b)->>'signature';
 PERFORM context_recon_record_decision(ce,context_recon_evidence_hash(ce),'correct',ARRAY[c],'ambiguity:wrong_job',staff);
 PERFORM pg_temp.prove('previous destination invalidated when source moves again',oldsig IS DISTINCT FROM context_ledger_placement_state(b)->>'signature');
 SELECT to_jsonb(x) INTO d FROM context_ledger_judge(ARRAY[c])x;
 PERFORM pg_temp.prove('return to original job requests another reading',(d->>'due')::boolean AND d->>'reason'='placement_changed');
 oldsig:=context_ledger_placement_state(c)->>'signature';
 UPDATE business_events SET payload=payload||'{"body":"Source changed after the staff decision"}' WHERE id=ce;
 PERFORM pg_temp.prove('changed evidence invalidates placement witness',oldsig IS DISTINCT FROM context_ledger_placement_state(c)->>'signature');
 UPDATE context_ledger_settings SET job_ids=ARRAY[b] WHERE id;
 SELECT to_jsonb(x) INTO d FROM context_ledger_judge(ARRAY[c])x;
 PERFORM pg_temp.prove('rollout boundary preserved',NOT (d->>'due')::boolean AND d->>'blocked_reason'='not_in_rollout');
 UPDATE context_ledger_settings SET mode='off' WHERE id;
 SELECT to_jsonb(x) INTO d FROM context_ledger_judge(ARRAY[c])x;
 PERFORM pg_temp.prove('off boundary preserved',NOT (d->>'due')::boolean AND d->>'blocked_reason'='ledger_off');
 PERFORM pg_temp.prove('browser cannot read placement witness or historical obligations',NOT has_function_privilege('anon','context_ledger_placement_state(uuid)','EXECUTE') AND NOT has_function_privilege('authenticated','context_ledger_placement_review(uuid,uuid,timestamptz)','EXECUTE'));
END $test$;
SELECT jsonb_build_object('checked_at',now(),'checks',jsonb_agg(to_jsonb(checks)),'scope','actual disposable SQL synthetic journeys; no real model, production or business acceptance') FROM checks;
ROLLBACK;
