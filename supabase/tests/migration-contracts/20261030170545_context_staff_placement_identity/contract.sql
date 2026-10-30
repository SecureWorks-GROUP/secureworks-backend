-- CTX-T24 actual staff identity projection; synthetic writes rolled back.
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
 staff uuid:='7e100000-0000-0000-0000-000000000001'; moved uuid:='7e200000-0000-0000-0000-000000000005'; m record; prior jsonb; enabled jsonb;
BEGIN
 DELETE FROM feature_flags WHERE flag_name='context_ledger_person_placement_v1';
 PERFORM context_recon_record_decision(moved,context_recon_evidence_hash(moved),'correct',ARRAY[c],'ambiguity:wrong_job',staff);
 SELECT to_jsonb(x) INTO prior FROM context_job_record_messages(ARRAY[c]) x WHERE source_id=moved::text;
 PERFORM pg_temp.prove('missing flag preserves prior staff projection',prior->>'sender_role'='customer' AND (prior->>'customer_side')::boolean);
 INSERT INTO feature_flags(flag_name,enabled) VALUES('context_ledger_person_placement_v1',false);
 PERFORM pg_temp.prove('off equals missing flag',prior=(SELECT to_jsonb(x) FROM context_job_record_messages(ARRAY[c]) x WHERE source_id=moved::text));
 UPDATE feature_flags SET enabled=true WHERE flag_name='context_ledger_person_placement_v1';
 SELECT * INTO m FROM context_job_record_messages(ARRAY[c]) WHERE source_id=moved::text;
 PERFORM pg_temp.prove('wrong-customer move is unknown to staff',m.sender_role='unknown' AND m.counterpart_role='unknown' AND NOT m.customer_side AND NOT m.is_job_contact);
 PERFORM pg_temp.prove('source identity words and dates retained',m.source_id=moved::text AND m.at='2026-10-06 09:10Z'::timestamptz AND m.words=prior->>'words');
 PERFORM pg_temp.prove('reader and staff agree on unknown sender',m.sender_role=(SELECT x.metadata#>>'{party_roles,sender_role}' FROM context_ledger_reader_events(ARRAY[c]) x WHERE id=moved));
 PERFORM pg_temp.prove('moved source absent from donor',NOT EXISTS(SELECT 1 FROM context_job_record_messages(ARRAY[a]) WHERE source_id=moved::text));
 PERFORM pg_temp.prove('as of bound retained',NOT EXISTS(SELECT 1 FROM context_job_record_messages(ARRAY[c],'2026-10-05 00:00Z') WHERE source_id=moved::text));
 PERFORM pg_temp.prove('source rows unchanged',NOT EXISTS(SELECT 1 FROM source_before old JOIN business_events x USING(id) WHERE (x.job_id,x.payload,x.metadata) IS DISTINCT FROM (old.job_id,old.payload,old.metadata)));
 PERFORM context_recon_record_decision(moved,context_recon_evidence_hash(moved),'correct',ARRAY[b],'ambiguity:wrong_job',staff);
 SELECT * INTO m FROM context_job_record_messages(ARRAY[b]) WHERE source_id=moved::text;
 PERFORM pg_temp.prove('matching destination contact retains customer identity',m.sender_role='customer' AND m.customer_side AND m.is_job_contact);
 PERFORM context_recon_record_decision(moved,context_recon_evidence_hash(moved),'split',ARRAY[a,c],'ambiguity:wrong_job',staff);
 PERFORM pg_temp.prove('split original retains original identity',EXISTS(SELECT 1 FROM context_job_record_messages(ARRAY[a]) WHERE source_id=moved::text AND sender_role='customer' AND customer_side));
 PERFORM pg_temp.prove('split other job remains unknown',EXISTS(SELECT 1 FROM context_job_record_messages(ARRAY[c]) WHERE source_id=moved::text AND sender_role='unknown' AND NOT customer_side));
 UPDATE business_events SET payload=payload||'{"from":"fixture@secureworksgroup.app"}' WHERE id=moved;
 PERFORM context_recon_record_decision(moved,context_recon_evidence_hash(moved),'correct',ARRAY[c],'ambiguity:wrong_job',staff);
 PERFORM pg_temp.prove('independently identified staff remains staff',EXISTS(SELECT 1 FROM context_job_record_messages(ARRAY[c]) WHERE source_id=moved::text AND sender_role='staff' AND counterpart_role='staff' AND NOT customer_side));
 UPDATE business_events SET payload=payload||'{"body":"Changed evidence"}' WHERE id=moved;
 PERFORM pg_temp.prove('stale decision does not project onto destination',NOT EXISTS(SELECT 1 FROM context_job_record_messages(ARRAY[c]) WHERE source_id=moved::text));
 PERFORM pg_temp.prove('stale decision retains original source identity',EXISTS(SELECT 1 FROM context_job_record_messages(ARRAY[a]) WHERE source_id=moved::text AND sender_role='staff'));
 PERFORM context_recon_record_decision(moved,context_recon_evidence_hash(moved),'unrelated',ARRAY[]::uuid[],'ambiguity:not_a_job',staff);
 PERFORM pg_temp.prove('unrelated remains absent from staff records',NOT EXISTS(SELECT 1 FROM context_job_record_messages(ARRAY[a,b,c]) WHERE source_id=moved::text));
 PERFORM pg_temp.prove('browser roles remain ungranted',NOT has_function_privilege('anon','context_job_record_messages(uuid[],timestamptz)','EXECUTE') AND NOT has_function_privilege('authenticated','context_job_record_messages(uuid[],timestamptz)','EXECUTE'));
END $test$;
SELECT jsonb_build_object('checks',count(*),'passed',bool_and(passed),'cases',jsonb_agg(name ORDER BY name)) FROM checks;
ROLLBACK;
