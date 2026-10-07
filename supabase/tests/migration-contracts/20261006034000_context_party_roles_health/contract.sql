-- Contract for 20261006034000_context_party_roles_health. Every fixture write
-- is rolled back; ids, job numbers, contacts, addresses and text are synthetic.
--
-- Proves:
--   A. The parties status block answers whatever shape
--      pricing_json.neighbour_splits has (JSON null, a scalar, an object
--      without a list, an empty list): no SQLSTATE 22023. It counts a live
--      fencing job whose fence-tool object lists neighbours and that has no
--      party row, and still counts a bare array (S-M1's shape); a closed job,
--      a patio job or a job with a party row does not count. The heartbeat
--      composes the block with no status_block_failed alarm.
--   B. The scorecard lane rule: L1d's recipient_role other (or a key with no
--      value) is a text; recipient_role crew or staff is a crew or staff text,
--      and so is an outbound text in one of our crew or staff templates, read
--      as the classifier reads one: context_internal_text_role's crew and
--      office templates (leading spaces trimmed, a text written with no
--      channel included) and the roof report make-safe alert. The same words
--      inbound, in an email or on the make-safe intake's arrival log row are
--      not a crew text, and near misses are texts. On every outbound text
--      sample the lane and the classifier's rule 1b (which copy its patterns)
--      agree with context_internal_text_role, run as postgres (the helper is
--      private to the ladder).
--   C. The classifier, v3, through the real insert trigger (the ladder runs
--      first): our crew and staff templates on an outbound text read staff to
--      crew or staff (basis our_template, audience internal) when the contact
--      is this job's customer, another job's customer, nobody we know, and on
--      a text written with no channel; the roof report make-safe alert reads
--      staff to crew (its recipients are crew); L1d's own label is still
--      copied first; the
--      same words inbound or in an email change nothing; an ordinary text
--      reads as before; every row is stamped party_roles_v3 (v4 once its
--      registered successor 20261007060000 is live); the classifier
--      writes no ladder-owned key; and the lane rule and the classifier agree
--      on every fixture row (a message is in the crew lane exactly when the
--      classifier reads it as ours to crew or staff).
--   D. Structure: bodies, comments, grants, the inlinable lane helper, the
--      definer status block, the untouched trigger and helpers (the
--      classifier's pin accepts its successor v4, 20261007060000).
--   E. A re-apply is a no-op (over v3's own classifier, stood back up from
--      v4's case when v4 is live).
--   F. The two pinned bodies the earlier contracts stand back up
--      (sm1_parties_status.sql for S-M1's re-apply, v2_message_party_roles.sql
--      for v2's) are S-M1's and v2's bodies and comments byte for byte, and
--      loading them moves no other function.
--   G. The service role can preview the classifier, as its grant and comment
--      promise: in a fresh session (no plan cached by postgres), as
--      service_role, our crew, office and roof report templates on an outbound
--      text read as ours. Rule 1b reads the words through context_event_text,
--      which the service role may call, never through L1d's private
--      context_internal_text_role, which it may not (SQLSTATE 42501).
-- A to C run in one block that names every failing fix at once, so the break
-- proof (the down migration applied) shows every fix fail before the fix.
\set ON_ERROR_STOP 1

CREATE FUNCTION pg_temp.ph_job(p_number text,p_type text,p_status text,p_contact text,p_pricing jsonb,p_email text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,client_email,pricing_json,archived,created_at)
  VALUES(j,'00000000-0000-0000-0000-000000000001',p_status,p_type,p_number,p_contact,p_email,p_pricing,false,now()-interval '30 days');
 RETURN j;
END $$;

-- One row through the real insert trigger, with the words in body_preview as
-- the writers store them (the scorecard's lane rule reads body_preview).
CREATE FUNCTION pg_temp.ph_ev(p_channel text,p_direction text,p_event text,p_contact text,p_payload jsonb,p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS public.business_events LANGUAGE plpgsql AS $$
DECLARE e public.business_events;
BEGIN
 INSERT INTO public.business_events(contact_id,entity_type,entity_id,direction,channel,event_type,source,
  provider_message_id,payload,metadata,occurred_at,event_at,body_preview)
  VALUES(p_contact,'contact',coalesce(p_contact,'none'),p_direction,p_channel,p_event,'party_roles_health_contract',
   'ph:'||replace(gen_random_uuid()::text,'-',''),p_payload,p_meta||'{"capture_mode":"live"}',now()-interval '1 day',now()-interval '1 day',
   left(coalesce(p_payload->>'body',p_payload->>'text',p_payload->>'message'),500))
  RETURNING * INTO e;
 RETURN e;
END $$;

-- Words as every writer stores them (body, text, message).
CREATE FUNCTION pg_temp.ph_words(p_words text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('body',p_words,'text',p_words,'message',p_words)
$$;

-- The version the live classifier stamps: a registered successor (v4,
-- 20261007060000) keeps every v3 decision these fixtures make and stamps its
-- own version; it proves that in its own contract.
CREATE FUNCTION pg_temp.ph_version() RETURNS text LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN coalesce(obj_description('public.context_message_party_roles(public.business_events)'::regprocedure,'pg_proc'),'')
  LIKE 'Party roles v4 (20261007060000):%' THEN 'party_roles_v4' ELSE 'party_roles_v3' END
$$;

-- '' when the row reads as expected, else what differs.
CREATE FUNCTION pg_temp.ph_roles(what text,e public.business_events,p_sender text,p_recipient text,p_basis text,p_audience text)
RETURNS text LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN r IS NULL OR r->>'version' IS DISTINCT FROM pg_temp.ph_version() OR r->>'sender_role' IS DISTINCT FROM p_sender
   OR r->>'recipient_role' IS DISTINCT FROM p_recipient OR r->>'counterpart_role' IS DISTINCT FROM CASE WHEN p_sender='staff' THEN p_recipient ELSE p_sender END
   OR r->>'basis' IS DISTINCT FROM p_basis OR r->>'audience' IS DISTINCT FROM p_audience
  THEN format('%s must read %s to %s (basis %s, audience %s, %s), got %s',what,p_sender,p_recipient,p_basis,p_audience,pg_temp.ph_version(),coalesce(r::text,'none'))
  ELSE '' END
 FROM (SELECT e.metadata->'party_roles' AS r) x
$$;

-- A to C.
BEGIN;
DO $$
DECLARE
 problems text[]:='{}'; miss text[]; base int; got int; s jsonb; c jsonb; j1 uuid; j2 uuid; jh uuid; e public.business_events; k text; t record;
 ev public.business_events; want text; r jsonb; agree text[]:='{}';
BEGIN
 -- A. The parties status block.
 BEGIN
  base:=(public.context_parties_status()#>>'{parties,pricing_neighbours_without_party_rows}')::int;
  PERFORM pg_temp.ph_job('SWF-994001','fencing','scheduled',NULL,'{"neighbour_splits":null}');
  PERFORM pg_temp.ph_job('SWF-994002','fencing','scheduled',NULL,'{"neighbour_splits":"none"}');
  PERFORM pg_temp.ph_job('SWF-994003','fencing','scheduled',NULL,'{"neighbour_splits":{"method":"equal"}}');
  PERFORM pg_temp.ph_job('SWF-994004','fencing','scheduled',NULL,'{"neighbour_splits":{"method":"equal","neighbours":[]}}');
  PERFORM pg_temp.ph_job('SWF-994005','fencing','scheduled',NULL,'{"neighbour_splits":{"method":"equal","neighbours":[{"id":"nb-1"}],"client_share_percent":50}}');
  PERFORM pg_temp.ph_job('SWF-994006','fencing','scheduled',NULL,'{"neighbour_splits":[{"id":"nb-1"}]}');
  PERFORM pg_temp.ph_job('SWF-994007','fencing','cancelled',NULL,'{"neighbour_splits":{"neighbours":[{"id":"nb-1"}]}}');
  PERFORM pg_temp.ph_job('SWP-994008','patio','scheduled',NULL,'{"neighbour_splits":{"neighbours":[{"id":"nb-1"}]}}');
  jh:=pg_temp.ph_job('SWF-994009','fencing','scheduled',NULL,'{"neighbour_splits":{"neighbours":[{"id":"nb-1"}]}}');
  INSERT INTO public.job_contacts(job_id,contact_type,client_name,is_primary) VALUES(jh,'neighbour_b','Fixture Neighbour Nine',false);
  s:=public.context_parties_status();
  got:=(s#>>'{parties,pricing_neighbours_without_party_rows}')::int;
  IF got IS DISTINCT FROM base+2 THEN
   problems:=problems||format('parties status not fixed: live fencing jobs listing neighbours (fence-tool object or bare array) with no party row must count %s, got %s',base+2,got);
  END IF;
  c:=public.context_pipeline_status();
  IF jsonb_typeof(c->'parties')<>'object' OR c->'parties' ? 'error' OR c->'alarms' @> '[{"block":"parties","key":"status_block_failed"}]'::jsonb THEN
   problems:=problems||format('parties status not fixed: the heartbeat must compose the parties block, got %s',c->'parties');
  END IF;
 EXCEPTION WHEN OTHERS THEN
  problems:=problems||format('parties status not fixed: the block failed with SQLSTATE %s (%s)',SQLSTATE,SQLERRM);
 END;

 -- B. The scorecard lane rule.
 miss:='{}';
 IF public.context_scorecard_lane_of('client.sms_out','ghl-history-load','sms','outbound','Hi, the gate is in',
     '{"recipient_role":"other","recipient_role_source":"contact","audience":"other_party"}') IS DISTINCT FROM 'texts' THEN
  miss:=miss||'L1d''s recipient_role other must be a text'::text; END IF;
 IF public.context_scorecard_lane_of('client.reply','ghl','sms','inbound','On my way','{"recipient_role":null}') IS DISTINCT FROM 'texts' THEN
  miss:=miss||'a recipient_role key with no value must be a text'::text; END IF;
 IF public.context_scorecard_lane_of('client.sms_out','ghl-proxy','sms','outbound','Can you call me?','{"recipient_role":"crew","audience":"internal"}') IS DISTINCT FROM 'crew_staff_texts' THEN
  miss:=miss||'a crew marker must be a crew or staff text'::text; END IF;
 IF public.context_scorecard_lane_of('client.sms_out','ghl-proxy','sms','outbound','Call the office','{"recipient_role":"staff"}') IS DISTINCT FROM 'crew_staff_texts' THEN
  miss:=miss||'a staff marker must be a crew or staff text'::text; END IF;
 IF public.context_scorecard_lane_of('client.sms_out','ghl-proxy','sms','outbound','New repair: SWR-1','{}') IS DISTINCT FROM 'crew_staff_texts' THEN
  miss:=miss||'our crew template must be a crew or staff text'::text; END IF;
 -- Our templates by their words, with no marker: the lane must read them as
 -- the classifier does (an outbound text, context_internal_text_role's
 -- templates or the roof report make-safe alert) and agree with
 -- context_internal_text_role on every sample.
 FOR t IN SELECT * FROM (VALUES
   ('an office alert (Docs Ready)','Docs Ready: SWF-993001 pack is ready','sms','outbound','client.sms_out','crew_staff_texts'),
   ('an office make-safe alert','SecureWorks: New make-safe MLB-990001: 9 Fixture Rd, Fixtureville (Fixture Builders)','sms','outbound','client.sms_out','crew_staff_texts'),
   ('the roof report make-safe alert','SecureWorks: New roof report make-safe MLB-990002: 8 Fixture Rd (Fixture Builders)','sms','outbound','client.sms_out','crew_staff_texts'),
   ('a crew template after spaces','  Job ready for crew: SWF-993001','sms','outbound','client.sms_out','crew_staff_texts'),
   ('an office alert written with no channel','Docs Ready: SWF-993001 pack is ready',NULL,NULL,'client.sms_out','crew_staff_texts'),
   ('a crew template inbound','New job assigned: SWF-993001 - Fixture Client','sms','inbound','client.reply','texts'),
   ('a crew template in an email','New job assigned: SWF-993001 - Fixture Client','email','outbound','client.email_out','emails_out'),
   ('the intake''s arrival log row','SecureWorks: New make-safe MLB-990001: 9 Fixture Rd',NULL,NULL,'makesafe.arrival_notified',NULL),
   ('a near miss (no colon)','Docs Ready SWF-993001','sms','outbound','client.sms_out','texts'),
   ('a near miss (alert with nothing after it)','SecureWorks: New make-safe','sms','outbound','client.sms_out','texts'),
   ('a near miss (a reply quoting a template)','Re: New job assigned: SWF-993001','sms','outbound','client.sms_out','texts'),
   ('an ordinary text','Hi, we are booked in for Tuesday','sms','outbound','client.sms_out','texts')
  ) AS v(what,words,ch,dir,et,want) LOOP
  k:=public.context_scorecard_lane_of(t.et,'ghl-proxy',t.ch,t.dir,t.words,'{}');
  IF k IS DISTINCT FROM t.want THEN miss:=miss||format('%s must be in lane %s, got %s',t.what,coalesce(t.want,'none'),coalesce(k,'none')); END IF;
  -- Agreement with L1d's template reading on the same row, for outbound
  -- texts: the lane and the classifier's rule 1b both copy its patterns (the
  -- roof report alert, which L1d does not name, is crew).
  IF t.dir='outbound' AND (t.ch='sms' OR t.ch IS NULL) THEN
   ev:=jsonb_populate_record(NULL::public.business_events,jsonb_build_object('payload',jsonb_build_object('body',t.words),
    'body_preview',t.words,'channel',t.ch,'direction',t.dir,'event_type',t.et,'metadata','{}'::jsonb));
   want:=CASE WHEN btrim(t.words) ~ '^SecureWorks: New roof report make-safe ' THEN 'crew' ELSE public.context_internal_text_role(ev) END;
   IF (k='crew_staff_texts') IS DISTINCT FROM (want IN ('crew','staff')) THEN
    miss:=miss||format('%s: the lane must agree with context_internal_text_role',t.what);
   END IF;
   BEGIN
    r:=public.context_message_party_roles(ev);
    IF (r->>'basis'='our_template') IS DISTINCT FROM (want IN ('crew','staff'))
     OR (want IN ('crew','staff') AND (r->>'sender_role' IS DISTINCT FROM 'staff' OR r->>'recipient_role' IS DISTINCT FROM want)) THEN
     agree:=agree||format('%s must read %s, got %s',t.what,
      CASE WHEN want IN ('crew','staff') THEN 'staff to '||want||' (our_template)' ELSE 'by its contact, not our_template' END,coalesce(r::text,'none'));
    END IF;
   EXCEPTION WHEN OTHERS THEN
    agree:=agree||format('%s failed with SQLSTATE %s (%s)',t.what,SQLSTATE,SQLERRM);
   END;
  END IF;
 END LOOP;
 IF cardinality(miss)>0 THEN problems:=problems||('lane rule not fixed: '||array_to_string(miss,', ')); END IF;
 IF cardinality(agree)>0 THEN
  problems:=problems||('template rule not fixed: rule 1b must agree with context_internal_text_role: '||array_to_string(agree,', '));
 END IF;

 -- C. The classifier, v3.
 BEGIN
  miss:='{}';
  j1:=pg_temp.ph_job('SWF-993001','fencing','scheduled','ph-crewcust','{}','crew.cust@example.test');
  j2:=pg_temp.ph_job('SWF-993002','fencing','scheduled','ph-cust2','{}');
  -- A crew member's contact that is also this job's customer on file.
  e:=pg_temp.ph_ev('sms','outbound','client.sms_out','ph-crewcust',pg_temp.ph_words(E'New job assigned: SWF-993001 - Fixture Client\nSite: 3 Fixture St'));
  k:=pg_temp.ph_roles('a crew template to the job''s customer contact',e,'staff','crew','our_template','internal');
  IF k<>'' THEN miss:=miss||k; END IF;
  IF e.metadata ? 'audience' OR e.metadata ? 'recipient_role' OR e.metadata ? 'recipient_role_source' THEN
   miss:=miss||format('the classifier must write no ladder-owned key, got %s',e.metadata); END IF;
  -- A contact nobody knows, a job number nobody has.
  e:=pg_temp.ph_ev('sms','outbound','client.sms_out','ph-nobody',pg_temp.ph_words(E'Job ready for crew: SWF-993099 - Fixture\nStage: scheduled'));
  k:=pg_temp.ph_roles('a crew template to an unknown contact',e,'staff','crew','our_template','internal');
  IF k<>'' THEN miss:=miss||k; END IF;
  -- An office alert to another job's customer contact.
  e:=pg_temp.ph_ev('sms','outbound','client.sms_out','ph-cust2',pg_temp.ph_words(E'SecureWorks: New make-safe 9 Fixture Rd\nAssign in Trade: https://example.test/x'));
  k:=pg_temp.ph_roles('an office alert to a customer''s contact',e,'staff','staff','our_template','internal');
  IF k<>'' THEN miss:=miss||k; END IF;
  -- An older writer that left channel and direction empty.
  e:=pg_temp.ph_ev(NULL,NULL,'client.sms_out','ph-crewcust',pg_temp.ph_words('Docs Ready: SWF-993001 pack is ready'));
  k:=pg_temp.ph_roles('an office alert with no channel',e,'staff','staff','our_template','internal');
  IF k<>'' THEN miss:=miss||k; END IF;
  -- The roof report wording of the office make-safe alert goes to crew (the
  -- roof recipients resolve to crew users), whoever the contact is.
  e:=pg_temp.ph_ev('sms','outbound','client.sms_out','ph-cust2',
   pg_temp.ph_words('SecureWorks: New roof report make-safe MLB-990001: 9 Fixture Rd, Fixtureville (Fixture Builders)'));
  k:=pg_temp.ph_roles('a roof report make-safe alert to a customer''s contact',e,'staff','crew','our_template','internal');
  IF k<>'' THEN miss:=miss||k; END IF;
  e:=pg_temp.ph_ev('sms','outbound','client.sms_out','ph-roofnobody',
   pg_temp.ph_words('SecureWorks: New roof report make-safe MLB-990002: 8 Fixture Rd (Fixture Builders)'));
  k:=pg_temp.ph_roles('a roof report make-safe alert to an unknown contact',e,'staff','crew','our_template','internal');
  IF k<>'' THEN miss:=miss||k; END IF;
  IF cardinality(miss)>0 THEN problems:=problems||('template rule not fixed: '||array_to_string(miss,'; ')); END IF;

  -- Regression guards: everything else reads as v2 did (stamped v3, or the
  -- live successor's version).
  miss:='{}';
  -- L1d's own label is copied first (contact not the job's customer, one reference).
  e:=pg_temp.ph_ev('sms','outbound','client.sms_out','ph-crew2',pg_temp.ph_words(E'New job assigned: SWF-993001 - Fixture Client\nSite: 3 Fixture St'));
  IF e.metadata->>'audience' IS DISTINCT FROM 'internal' OR e.metadata->>'recipient_role' IS DISTINCT FROM 'crew' THEN
   miss:=miss||format('fixture: L1d must label the crew text internal, got %s',e.metadata); END IF;
  k:=pg_temp.ph_roles('L1d''s crew text',e,'staff','crew','ladder_internal','internal');
  IF k<>'' THEN miss:=miss||k; END IF;
  -- The same words inbound are the customer's own message.
  e:=pg_temp.ph_ev('sms','inbound','client.reply','ph-crewcust',pg_temp.ph_words('New job assigned: SWF-993001 - Fixture Client'));
  IF e.metadata->'party_roles'->>'counterpart_role' IS DISTINCT FROM 'customer' OR e.metadata->'party_roles'->>'basis'='our_template'
   OR e.metadata->'party_roles'->>'version' IS DISTINCT FROM pg_temp.ph_version() THEN
   miss:=miss||format('an inbound text in our template words must read as the customer''s, got %s',e.metadata->'party_roles'); END IF;
  -- The same words in an email are not a text.
  e:=pg_temp.ph_ev('email','outbound','client.email_out',NULL,
   pg_temp.ph_words('New job assigned: SWF-993001 - Fixture Client')||'{"email":"crew.cust@example.test"}'::jsonb);
  IF e.metadata->'party_roles'->>'counterpart_role' IS DISTINCT FROM 'customer' OR e.metadata->'party_roles'->>'basis'='our_template'
   OR e.metadata->'party_roles'->>'version' IS DISTINCT FROM pg_temp.ph_version() THEN
   miss:=miss||format('an email in our template words must read by its address, got %s',e.metadata->'party_roles'); END IF;
  -- An ordinary text to the job's customer.
  e:=pg_temp.ph_ev('sms','outbound','client.sms_out','ph-crewcust',pg_temp.ph_words('Hi, we are booked in for Tuesday'));
  IF e.metadata->'party_roles'->>'recipient_role' IS DISTINCT FROM 'customer' OR e.metadata->'party_roles'->>'basis'='our_template'
   OR e.metadata->'party_roles'->>'version' IS DISTINCT FROM pg_temp.ph_version() THEN
   miss:=miss||format('an ordinary text to the customer must read customer, got %s',e.metadata->'party_roles'); END IF;
  -- The roof report wording inbound is the contact's own message.
  e:=pg_temp.ph_ev('sms','inbound','client.reply','ph-cust2',pg_temp.ph_words('SecureWorks: New roof report make-safe MLB-990001: 9 Fixture Rd'));
  IF e.metadata->'party_roles'->>'basis'='our_template' OR e.metadata->'party_roles'->>'sender_role'='staff'
   OR e.metadata->'party_roles'->>'version' IS DISTINCT FROM pg_temp.ph_version() THEN
   miss:=miss||format('an inbound text in the roof alert''s words must read as the contact''s, got %s',e.metadata->'party_roles'); END IF;
  -- A non-message row carries none.
  e:=pg_temp.ph_ev('status','system','job.status_changed','ph-crewcust','{"to":"scheduled"}'::jsonb);
  IF e.metadata ? 'party_roles' THEN miss:=miss||format('a non-message row must carry no party roles, got %s',e.metadata); END IF;
  IF cardinality(miss)>0 THEN problems:=problems||('classifier regression: '||array_to_string(miss,'; ')); END IF;

  -- The lane rule and the classifier agree on every fixture message: a row is
  -- in the crew and staff lane exactly when the classifier reads it as ours to
  -- crew or staff (L1d's label, a writer marker or our template).
  SELECT string_agg(format('%s (lane %s, roles %s)',left(b.body_preview,40),coalesce(l.lane,'none'),b.metadata->'party_roles'),'; '
    ORDER BY b.provider_message_id COLLATE "C",b.id) INTO k
  FROM public.business_events b
  CROSS JOIN LATERAL (SELECT public.context_scorecard_lane_of(b.event_type,b.source,b.channel,b.direction,b.body_preview,b.metadata) AS lane) l
  WHERE b.source='party_roles_health_contract' AND b.metadata ? 'party_roles'
   AND (l.lane='crew_staff_texts') IS DISTINCT FROM (b.metadata->'party_roles'->>'basis' IN ('our_template','ladder_internal','writer'));
  IF k IS NOT NULL THEN problems:=problems||('lane rule not fixed: the lane and the classifier disagree on '||k); END IF;
 EXCEPTION WHEN OTHERS THEN
  problems:=problems||format('template rule not fixed: the fixtures failed with SQLSTATE %s (%s)',SQLSTATE,SQLERRM);
 END;

 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'party roles health contract: %',array_to_string(problems,' | ');
 END IF;
END $$;
ROLLBACK;

-- D. Structure.
DO $$
DECLARE p record; f text; r text;
BEGIN
 FOR p IN SELECT * FROM (VALUES
  ('public.context_parties_status()','5f01b621c22b3cb0840bf04eb32a338f','Status block parties (sites.md section 8)%Since 20261006034000%'),
  ('public.context_scorecard_lane_of(text,text,text,text,text,jsonb)','2b51a7422882b6b1d77988fdd3860230','Context scorecard (20261006032000)%Since 20261006034000%'),
  -- The classifier: this migration's body, or its registered successor's
  -- (v4, 20261007060000, which pins its own body in its own contract).
  ('public.context_message_party_roles(public.business_events)',
   CASE WHEN coalesce(obj_description('public.context_message_party_roles(public.business_events)'::regprocedure,'pg_proc'),'')
    LIKE 'Party roles v4 (20261007060000):%' THEN '17a10cf9b9180a6380e8465d2dce503b' ELSE '36ed4eac4ec8a1b2efd253da02add409' END,
   CASE WHEN coalesce(obj_description('public.context_message_party_roles(public.business_events)'::regprocedure,'pg_proc'),'')
    LIKE 'Party roles v4 (20261007060000):%' THEN 'Party roles v4 (20261007060000):%' ELSE 'Party roles v3 (20261006034000):%' END)
 ) AS t(sig,md5,note) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(p.sig)) IS DISTINCT FROM p.md5 THEN
   RAISE EXCEPTION 'party roles health: % is not this migration''s body',p.sig; END IF;
  IF coalesce(obj_description(to_regprocedure(p.sig),'pg_proc'),'') NOT LIKE p.note THEN
   RAISE EXCEPTION 'party roles health: % comment is not this migration''s',p.sig; END IF;
  FOREACH r IN ARRAY ARRAY['anon','authenticated','public'] LOOP
   IF has_function_privilege(r,p.sig,'EXECUTE') THEN RAISE EXCEPTION 'party roles health: % can call %',r,p.sig; END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role',p.sig,'EXECUTE') THEN RAISE EXCEPTION 'party roles health: the service role must call %',p.sig; END IF;
 END LOOP;
 -- The lane helper stays inlinable; the status block stays a pinned definer.
 IF EXISTS (SELECT 1 FROM pg_proc pr JOIN pg_language l ON l.oid=pr.prolang
   WHERE pr.oid='public.context_scorecard_lane_of(text,text,text,text,text,jsonb)'::regprocedure
    AND (pr.prosecdef OR pr.proconfig IS NOT NULL OR pr.provolatile<>'i' OR l.lanname<>'sql')) THEN
  RAISE EXCEPTION 'party roles health: the lane helper must stay an inlinable immutable SQL function'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_proc pr WHERE pr.oid='public.context_parties_status()'::regprocedure
    AND pr.prosecdef AND pr.provolatile='s' AND 'search_path=public, pg_temp'=ANY(pr.proconfig)) THEN
  RAISE EXCEPTION 'party roles health: the parties status block must stay STABLE SECURITY DEFINER with search_path public, pg_temp'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_proc pr WHERE pr.oid='public.context_message_party_roles(public.business_events)'::regprocedure
    AND NOT pr.prosecdef AND pr.provolatile='s' AND pr.proconfig IS NULL) THEN
  RAISE EXCEPTION 'party roles health: the classifier must stay a STABLE invoker function with no SET clause'; END IF;
 -- Read, not replaced.
 FOR p IN SELECT * FROM (VALUES
  ('public.context_internal_text_role(public.business_events)','e7327d108966e2bcb9d2eb48e3086a55'),
  ('public.context_stamp_party_roles()','de974f45ef3174e9391a3d31369df179'),
  ('public.context_party_user_role(text,text)','17bdaa22bb55de8635c1dd8563d070d1'),
  ('public.context_party_builder_address(text)','ccd5e9acd5d51228007c3af14054c474'),
  ('public.context_party_supplier_key(text,text)','92a1eb902c4a0aa0aab05d1aa7707352'),
  ('public.context_party_key_roles(text,text)','4da54e7c7107e927b350947697f440e7'),
  ('public.context_party_contact_roles(text)','8c1f5381cb41d2cdcb0f33b530cc3070')
 ) AS t(sig,md5) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(p.sig)) IS DISTINCT FROM p.md5 THEN
   RAISE EXCEPTION 'party roles health: % changed',p.sig; END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid='public.business_events'::regclass AND NOT t.tgisinternal
   AND t.tgname='context_party_roles_business_event' AND t.tgfoid='public.context_stamp_party_roles()'::regprocedure)<>1 THEN
  RAISE EXCEPTION 'party roles health: the party-role trigger changed'; END IF;
END $$;

-- E. A re-apply is a no-op. A registered successor (v4, 20261007060000)
-- replaces the classifier; whenever the live body is not v3's, stand v3's
-- classifier back up first, inside this rolled-back block, from the body that
-- case pins (and nothing else), so this migration's guard sees the pre-image
-- it was written for.
BEGIN;
SELECT md5(prosrc)<>'36ed4eac4ec8a1b2efd253da02add409' AS ph_classifier_moved
FROM pg_proc WHERE oid='public.context_message_party_roles(public.business_events)'::regprocedure \gset
\if :ph_classifier_moved
\ir ../20261007060000_context_party_roles_v4/v3_message_party_roles.sql
\endif
CREATE TEMP TABLE ph_before AS SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS m, obj_description(p.oid,'pg_proc') AS note, p.proacl::text AS acl
 FROM pg_proc p WHERE p.oid IN ('public.context_parties_status()'::regprocedure,
  'public.context_scorecard_lane_of(text,text,text,text,text,jsonb)'::regprocedure,'public.context_message_party_roles(public.business_events)'::regprocedure);
\ir ../../../migrations/20261006034000_context_party_roles_health.sql
DO $$
BEGIN
 IF (SELECT count(*) FROM ph_before)<>3 OR EXISTS (SELECT 1 FROM ph_before b JOIN pg_proc p ON p.oid=b.sig::regprocedure
   WHERE md5(p.prosrc) IS DISTINCT FROM b.m OR obj_description(p.oid,'pg_proc') IS DISTINCT FROM b.note OR p.proacl::text IS DISTINCT FROM b.acl)
 THEN RAISE EXCEPTION 'party roles health: a re-apply changed a body, comment or grant'; END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgname='context_party_roles_business_event')<>1 THEN
  RAISE EXCEPTION 'party roles health: a re-apply duplicated the trigger'; END IF;
END $$;
ROLLBACK;

-- F. The pinned bodies the earlier contracts stand back up: S-M1's re-apply
-- loads sm1_parties_status.sql and v2's re-apply loads
-- v2_message_party_roles.sql whenever the live body is not theirs. Each is
-- that body and comment byte for byte, and loading them moves no other
-- function, so a later change to one function never breaks a contract about
-- another.
BEGIN;
CREATE TEMP TABLE ph_f_before AS SELECT p.oid, p.oid::regprocedure::text AS sig, md5(p.prosrc) AS m, obj_description(p.oid,'pg_proc') AS note
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public';
\ir sm1_parties_status.sql
\ir v2_message_party_roles.sql
DO $$
DECLARE moved text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_parties_status()'::regprocedure) IS DISTINCT FROM '98ca15b42682e9210ac4e6fe8d74ccd3'
  OR coalesce(obj_description('public.context_parties_status()'::regprocedure,'pg_proc'),'')
   NOT LIKE 'Status block parties (sites.md section 8), owned by sites S-M1:%Counts only, no names.' THEN
  RAISE EXCEPTION 'party roles health: sm1_parties_status.sql is not S-M1''s parties block and comment'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_message_party_roles(public.business_events)'::regprocedure)
   IS DISTINCT FROM '8d5bb9cfa80a631ee39497282e54f967'
  OR coalesce(obj_description('public.context_message_party_roles(public.business_events)'::regprocedure,'pg_proc'),'')
   NOT LIKE 'Party roles v2 (20261006000000):%Service role may call it to preview.' THEN
  RAISE EXCEPTION 'party roles health: v2_message_party_roles.sql is not v2''s classifier and comment'; END IF;
 SELECT string_agg(b.sig,', ' ORDER BY b.sig COLLATE "C",b.oid) INTO moved
 FROM ph_f_before b LEFT JOIN pg_proc p ON p.oid=b.oid
 WHERE b.oid NOT IN ('public.context_parties_status()'::regprocedure,'public.context_message_party_roles(public.business_events)'::regprocedure)
  AND (p.oid IS NULL OR md5(p.prosrc) IS DISTINCT FROM b.m OR obj_description(p.oid,'pg_proc') IS DISTINCT FROM b.note);
 IF moved IS NOT NULL THEN RAISE EXCEPTION 'party roles health: loading the pinned bodies moved %',moved; END IF;
 IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public')<>(SELECT count(*) FROM ph_f_before) THEN
  RAISE EXCEPTION 'party roles health: loading the pinned bodies added or dropped a function'; END IF;
END $$;
ROLLBACK;

-- G. The service role previews the classifier. A fresh session, so no plan
-- postgres cached earlier hides a missing grant; the rows are built in memory
-- (no table write, no table read: each returns at rule 1b).
\c
SET ROLE service_role;
DO $$
DECLARE t record; r jsonb; miss text[]:='{}';
BEGIN
 FOR t IN SELECT * FROM (VALUES
   ('a crew template','New job assigned: SWF-993001 - Fixture Client','sms','outbound','client.sms_out','crew'),
   ('an office alert','Docs Ready: SWF-993001 pack is ready','sms','outbound','client.sms_out','staff'),
   ('an office alert written with no channel','SecureWorks: New make-safe MLB-990001: 9 Fixture Rd',NULL,NULL,'client.sms_out','staff'),
   ('the roof report make-safe alert','SecureWorks: New roof report make-safe MLB-990002: 8 Fixture Rd','sms','outbound','client.sms_out','crew')
  ) AS v(what,words,ch,dir,et,want) LOOP
  BEGIN
   r:=public.context_message_party_roles(jsonb_populate_record(NULL::public.business_events,jsonb_build_object(
    'id',gen_random_uuid(),'contact_id','ph-preview','channel',t.ch,'direction',t.dir,'event_type',t.et,
    'payload',jsonb_build_object('body',t.words),'body_preview',t.words,'metadata','{}'::jsonb)));
   IF r->>'recipient_role' IS DISTINCT FROM t.want OR r->>'basis' IS DISTINCT FROM 'our_template' OR r->>'sender_role' IS DISTINCT FROM 'staff' THEN
    miss:=miss||format('%s must read staff to %s (our_template), got %s',t.what,t.want,coalesce(r::text,'none'));
   END IF;
  EXCEPTION WHEN OTHERS THEN
   miss:=miss||format('%s failed with SQLSTATE %s (%s)',t.what,SQLSTATE,SQLERRM);
  END;
 END LOOP;
 IF cardinality(miss)>0 THEN
  RAISE EXCEPTION 'party roles health contract: service role preview not fixed: %',array_to_string(miss,'; ');
 END IF;
END $$;
RESET ROLE;
