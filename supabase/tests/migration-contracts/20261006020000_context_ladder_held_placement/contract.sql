-- Ladder L1f contract (20261006020000). Every fixture write is rolled back.
-- Ids, job numbers, contacts, phones and text are synthetic.
--
-- Each class is decided with the rules flag off (as shipped) and on, through
-- the stored row: the preview and a real re-decision (the one-argument entry,
-- which reads the flag) must agree.
--   A. Confirmed custody (P4 preview class a). A public-key scope record with
--      no words that the reviewed writer-key relink put on its job keeps it
--      with the rules on, as with them off (placement_rule
--      confirmed_custody); so does an automated one. Controls: the same row
--      with a binding the ladder stamped (no via), a public-key insert naming
--      a job, and a worded public-key row with a confirmed binding keep
--      nothing with the rules on.
--   B. Drafts (class b, unchanged behaviour). A lead's text whose only job is
--      a draft (here a contactless draft matched by the text's own phone) is
--      placed on the draft with the rules on; a live job for the same phone
--      outranks the draft.
--   C. Held placement (class c). A call transcript a contact rule put on a
--      job in status invoiced with a completion time stays on it with the
--      rules on (it went to aftercare review before); so does a row whose
--      job finished long ago with nothing unpaid (it went to the bucket), a
--      row whose phone another contact's job shares (identity conflict) and a
--      row whose email thread binding was retired. With the rules off every
--      one stays as before. Control: once a new job of the customer is live
--      at the message time (its insert runs P1b's reconsideration), the row
--      goes to review as before, and a row placed by a reference is not held.
--   D. Structure: the body is L1e's plus exactly these edits, the rules-off
--      ladder, the entry and the insert trigger are untouched, the body is
--      private and marked L1f, the flag stays off, and a re-apply is a no-op.
\set ON_ERROR_STOP 1

CREATE FUNCTION pg_temp.hp_job(p_number text,p_contact text,p_status text,p_created interval,p_completed interval DEFAULT NULL,
 p_phone text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at,completed_at,client_phone)
  VALUES(j,'00000000-0000-0000-0000-000000000001',p_status,'fencing',p_number,p_contact,now()-p_created,now()-p_completed,p_phone);
 RETURN j;
END $$;

-- One record through the real insert trigger, as the given request role.
CREATE FUNCTION pg_temp.hp_ev(p_source text,p_event text,p_job uuid,p_method text,p_payload jsonb,p_channel text,p_direction text,
 p_contact text,p_role text DEFAULT NULL,p_at interval DEFAULT interval '5 days',p_thread text DEFAULT NULL)
RETURNS public.business_events LANGUAGE plpgsql AS $$
DECLARE e public.business_events;
BEGIN
 IF p_role IS NOT NULL THEN PERFORM set_config('request.jwt.claims',jsonb_build_object('role',p_role)::text,true); END IF;
 INSERT INTO public.business_events(job_id,match_method,contact_id,entity_type,entity_id,direction,channel,event_type,source,
  provider_message_id,thread_key,payload,metadata,occurred_at,event_at)
  VALUES(p_job,p_method,p_contact,'job','hp-fixture',p_direction,p_channel,p_event,p_source,
   CASE WHEN p_contact IS NOT NULL THEN 'ghl:hp'||replace(gen_random_uuid()::text,'-','') END,p_thread,
   p_payload,'{"capture_mode":"live"}',now()-p_at,now()-p_at)
  RETURNING * INTO e;
 PERFORM set_config('request.jwt.claims','',true);
 RETURN e;
END $$;

CREATE FUNCTION pg_temp.hp_flag(p_on boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 UPDATE public.feature_flags SET enabled=p_on,updated_at=clock_timestamp() WHERE flag_name='context_unlinked_rules_v1';
 IF public.context_unlinked_rules_enabled() IS DISTINCT FROM p_on THEN RAISE EXCEPTION 'l1f fixture: flag not %',p_on; END IF;
END $$;

-- What the ladder decides for a stored row with the flag as it is: the
-- preview (rules forced to the flag) and a real re-decision must agree.
CREATE FUNCTION pg_temp.hp_decide(p_id uuid,p_label text) RETURNS public.business_events LANGUAGE plpgsql AS $$
DECLARE e public.business_events; r public.business_events; p jsonb;
BEGIN
 SELECT * INTO e FROM public.business_events WHERE id=p_id;
 p:=public.context_attribution_preview(p_id,public.context_unlinked_rules_enabled());
 r:=public.resolve_context_attribution(e);
 IF p->'decided'->>'job_id' IS DISTINCT FROM r.job_id::text OR p->'decided'->>'attribution_status' IS DISTINCT FROM r.attribution_status
  OR p->'decided'->>'placement_rule' IS DISTINCT FROM r.metadata->>'placement_rule'
 THEN RAISE EXCEPTION 'l1f %: the preview and the re-decision disagree: % vs % % %',p_label,p->'decided',r.attribution_status,r.job_id,r.metadata->>'placement_rule'; END IF;
 RETURN r;
END $$;

-- The reviewed writer-key relink, as data/cio-ctx-linking-fixes/relink.sql
-- writes it (service role, after the insert).
CREATE FUNCTION pg_temp.hp_relink(p_id uuid,p_job uuid,p_via text) RETURNS void LANGUAGE sql AS $$
 UPDATE public.business_events SET job_id=p_job,match_method='direct_job_id',match_status='matched',match_confidence=1,
  metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('source_job_binding',
   CASE WHEN p_via IS NULL THEN jsonb_build_object('job_id',p_job,'match_method','direct_job_id')
    ELSE jsonb_build_object('job_id',p_job,'match_method','direct_job_id','via',p_via) END,
   'placement_rule','writer_key_relink','capture_mode','relink')
 WHERE id=p_id
$$;

CREATE FUNCTION pg_temp.hp_cases() RETURNS void LANGUAGE plpgsql AS $$
DECLARE jp uuid; jd uuid; jl uuid; ji uuid; jo uuid; jold uuid; jn uuid; jr uuid; e public.business_events; r public.business_events;
 f boolean; lbl text;
 scope constant jsonb:='{"decision_type":"roof_pitch","details":{"pitch":5}}';
BEGIN
 ---------------------------------------------------------------- A. confirmed custody
 PERFORM pg_temp.hp_flag(false);
 jp:=pg_temp.hp_job('SWP-992001','hp-patio','scheduled',interval '30 days');
 -- The patio tool's own record: public key, job only in payload.job_id, no words.
 e:=pg_temp.hp_ev('patio-tool','scope.decision',NULL,NULL,scope||jsonb_build_object('job_id',jp),NULL,NULL,NULL,'anon');
 IF e.job_id IS NOT NULL OR e.attribution_status<>'empty' OR e.metadata->>'written_as'<>'anon'
 THEN RAISE EXCEPTION 'l1f A: the patio record must arrive empty with no job, got % %',e.attribution_status,e.job_id; END IF;
 PERFORM pg_temp.hp_relink(e.id,jp,'writer_key_relink');
 FOREACH f IN ARRAY ARRAY[false,true] LOOP
  PERFORM pg_temp.hp_flag(f); lbl:=CASE WHEN f THEN 'rules on' ELSE 'rules off' END;
  r:=pg_temp.hp_decide(e.id,'A '||lbl);
  IF r.job_id IS DISTINCT FROM jp OR r.attribution_status<>'empty'
   OR (f AND r.metadata->>'placement_rule' IS DISTINCT FROM 'confirmed_custody')
  THEN RAISE EXCEPTION 'l1f A %: a relinked patio record must keep its job, got % % %',lbl,r.attribution_status,r.job_id,r.metadata->>'placement_rule'; END IF;
 END LOOP;
 -- An automated row from the same writer, relinked: kept, automated.
 PERFORM pg_temp.hp_flag(false);
 e:=pg_temp.hp_ev('patio-tool','scope.decision',NULL,NULL,'{"body":"Auto reply","automated":"true"}',NULL,NULL,NULL,'anon');
 PERFORM pg_temp.hp_relink(e.id,jp,'writer_key_relink');
 FOREACH f IN ARRAY ARRAY[false,true] LOOP
  PERFORM pg_temp.hp_flag(f); lbl:=CASE WHEN f THEN 'rules on' ELSE 'rules off' END;
  r:=pg_temp.hp_decide(e.id,'A automated '||lbl);
  IF r.job_id IS DISTINCT FROM jp OR r.attribution_status<>'automated'
  THEN RAISE EXCEPTION 'l1f A %: a relinked automated record must keep its job, got % %',lbl,r.attribution_status,r.job_id; END IF;
 END LOOP;
 -- Controls with the rules on. A binding without via (what the rules-off
 -- ladder stamps for any writer) proves nothing.
 PERFORM pg_temp.hp_flag(false);
 e:=pg_temp.hp_ev('patio-tool','scope.decision',NULL,NULL,scope,NULL,NULL,NULL,'anon');
 PERFORM pg_temp.hp_relink(e.id,jp,NULL);
 PERFORM pg_temp.hp_flag(true);
 r:=pg_temp.hp_decide(e.id,'A no via');
 IF r.job_id IS NOT NULL OR r.metadata->>'placement_rule' IS DISTINCT FROM 'unverified_writer'
 THEN RAISE EXCEPTION 'l1f A: a binding without via must not keep a public-key row, got % %',r.attribution_status,r.job_id; END IF;
 -- A public-key insert naming a job with a certain method pins nothing.
 e:=pg_temp.hp_ev('patio-tool','scope.decision',jp,'direct_job_id',scope,NULL,NULL,NULL,'anon');
 IF e.job_id IS NOT NULL OR e.metadata ? 'source_job_binding'
 THEN RAISE EXCEPTION 'l1f A: a public-key insert must not pin a job, got % %',e.attribution_status,e.job_id; END IF;
 -- A worded public-key row stays held even with a confirmed binding.
 PERFORM pg_temp.hp_flag(false);
 e:=pg_temp.hp_ev('patio-tool','scope.decision',NULL,NULL,'{"body":"Please call me about the patio"}',NULL,NULL,NULL,'anon');
 PERFORM pg_temp.hp_relink(e.id,jp,'writer_key_relink');
 PERFORM pg_temp.hp_flag(true);
 r:=pg_temp.hp_decide(e.id,'A worded');
 IF r.job_id IS NOT NULL OR r.metadata->>'placement_rule' IS DISTINCT FROM 'unverified_writer'
 THEN RAISE EXCEPTION 'l1f A: a worded public-key row must stay held, got % %',r.attribution_status,r.job_id; END IF;

 ---------------------------------------------------------------- B. drafts
 PERFORM pg_temp.hp_flag(false);
 jd:=pg_temp.hp_job('SWP-992010',NULL,'draft',interval '10 days',NULL,'0412 990 010');
 e:=pg_temp.hp_ev('ghl-message-reconcile','client.sms_in',NULL,NULL,'{"body":"Hi, any update on my quote?","phone":"+61412990010"}',
  'sms','inbound','hp-lead',NULL,interval '2 days');
 IF e.job_id IS NOT NULL THEN RAISE EXCEPTION 'l1f B: rules off must not find the contactless draft, got %',e.job_id; END IF;
 PERFORM pg_temp.hp_flag(true);
 r:=pg_temp.hp_decide(e.id,'B draft');
 IF r.job_id IS DISTINCT FROM jd OR r.attribution_status<>'single_open'
 THEN RAISE EXCEPTION 'l1f B: the lead''s only job (a draft) must be its home, got % %',r.attribution_status,r.job_id; END IF;
 -- A live job for the same phone outranks the draft.
 jl:=pg_temp.hp_job('SWP-992011',NULL,'scheduled',interval '10 days',NULL,'0412 990 010');
 r:=pg_temp.hp_decide(e.id,'B live');
 IF r.job_id IS DISTINCT FROM jl
 THEN RAISE EXCEPTION 'l1f B: a live job must outrank a draft, got % %',r.attribution_status,r.job_id; END IF;

 ---------------------------------------------------------------- C. held placement
 -- C1. A call transcript placed on a job invoiced 20 days before the call.
 PERFORM pg_temp.hp_flag(false);
 ji:=pg_temp.hp_job('SWF-992020','hp-cust','invoiced',interval '90 days',interval '25 days');
 e:=pg_temp.hp_ev('ghl-call-transcript','call.transcript_completed',NULL,NULL,'{"transcript":"Hi, it is about the gate latch you fitted"}',
  'call','inbound','hp-cust');
 IF e.job_id IS DISTINCT FROM ji OR e.attribution_status<>'single_open'
 THEN RAISE EXCEPTION 'l1f C1: rules off must place the call on the invoiced job, got % %',e.attribution_status,e.job_id; END IF;
 FOREACH f IN ARRAY ARRAY[false,true] LOOP
  PERFORM pg_temp.hp_flag(f); lbl:=CASE WHEN f THEN 'rules on' ELSE 'rules off' END;
  r:=pg_temp.hp_decide(e.id,'C1 '||lbl);
  IF r.job_id IS DISTINCT FROM ji OR r.attribution_status<>'single_open' OR r.match_method<>'contact_id'
   OR (f AND (r.metadata->>'placement_rule' IS DISTINCT FROM 'held_placement' OR r.metadata->>'placement_held_from' IS DISTINCT FROM 'review_aftercare'))
  THEN RAISE EXCEPTION 'l1f C1 %: the call must stay on its job, got % % % %',lbl,r.attribution_status,r.job_id,r.metadata->>'placement_rule',r.metadata->>'placement_held_from'; END IF;
 END LOOP;
 -- C2. A row on a job invoiced 200 days before, nothing unpaid: was the bucket.
 PERFORM pg_temp.hp_flag(false);
 jold:=pg_temp.hp_job('SWF-992021','hp-old','invoiced',interval '400 days',interval '205 days');
 e:=pg_temp.hp_ev('ghl-message-reconcile','client.sms_in',NULL,NULL,'{"body":"Thanks again for the fence"}','sms','inbound','hp-old');
 IF e.job_id IS DISTINCT FROM jold THEN RAISE EXCEPTION 'l1f C2: rules off must place on the invoiced job, got %',e.job_id; END IF;
 FOREACH f IN ARRAY ARRAY[false,true] LOOP
  PERFORM pg_temp.hp_flag(f); lbl:=CASE WHEN f THEN 'rules on' ELSE 'rules off' END;
  r:=pg_temp.hp_decide(e.id,'C2 '||lbl);
  IF r.job_id IS DISTINCT FROM jold OR (f AND r.metadata->>'placement_held_from' IS DISTINCT FROM 'no_candidate_at_time')
  THEN RAISE EXCEPTION 'l1f C2 %: the row must stay on its job, got % % %',lbl,r.attribution_status,r.job_id,r.metadata->>'placement_held_from'; END IF;
 END LOOP;
 -- C3. Another contact's job shares the sender's phone (identity conflict).
 PERFORM pg_temp.hp_flag(false);
 jl:=pg_temp.hp_job('SWF-992022','hp-share','scheduled',interval '30 days',NULL,'0413 990 022');
 jo:=pg_temp.hp_job('SWF-992023','hp-share-other','scheduled',interval '30 days',NULL,'0413 990 022');
 e:=pg_temp.hp_ev('ghl-message-reconcile','client.sms_in',NULL,NULL,'{"body":"Running 10 minutes late","phone":"+61413990022"}','sms','inbound','hp-share');
 IF e.job_id IS DISTINCT FROM jl THEN RAISE EXCEPTION 'l1f C3: rules off must place on the contact''s job, got %',e.job_id; END IF;
 FOREACH f IN ARRAY ARRAY[false,true] LOOP
  PERFORM pg_temp.hp_flag(f); lbl:=CASE WHEN f THEN 'rules on' ELSE 'rules off' END;
  r:=pg_temp.hp_decide(e.id,'C3 '||lbl);
  IF r.job_id IS DISTINCT FROM jl OR (f AND r.metadata->>'placement_held_from' IS DISTINCT FROM 'review_identity_conflict')
  THEN RAISE EXCEPTION 'l1f C3 %: the row must stay on its job, got % % %',lbl,r.attribution_status,r.job_id,r.metadata->>'placement_held_from'; END IF;
 END LOOP;
 -- C4. An email whose thread binding was later retired.
 PERFORM pg_temp.hp_flag(false);
 jl:=pg_temp.hp_job('SWF-992024','hp-mail','scheduled',interval '30 days');
 jr:=pg_temp.hp_job('SWF-992025','hp-mail-x','scheduled',interval '30 days');
 e:=pg_temp.hp_ev('monitor-inbox','client.email_in',NULL,NULL,'{"subject":"Gate","body":"Can we change the colour?"}','email','inbound','hp-mail',
  NULL,interval '5 days','outlook:hp-conv-992024');
 IF e.job_id IS DISTINCT FROM jl THEN RAISE EXCEPTION 'l1f C4: rules off must place the email on the contact''s job, got %',e.job_id; END IF;
 INSERT INTO public.event_threads(thread_key,job_id,bound_by,source_event_id) VALUES('outlook:hp-conv-992024',jl,'ladder',e.id) ON CONFLICT DO NOTHING;
 UPDATE public.event_threads SET retired_at=now(),retired_reason='conflict',retired_conflict_job_id=jr WHERE thread_key='outlook:hp-conv-992024';
 FOREACH f IN ARRAY ARRAY[false,true] LOOP
  PERFORM pg_temp.hp_flag(f); lbl:=CASE WHEN f THEN 'rules on' ELSE 'rules off' END;
  r:=pg_temp.hp_decide(e.id,'C4 '||lbl);
  IF r.job_id IS DISTINCT FROM jl THEN RAISE EXCEPTION 'l1f C4 %: the email must stay on its job, got % % %',lbl,r.attribution_status,r.job_id,r.metadata->>'placement_rule'; END IF;
 END LOOP;
 -- C5. Control: a new job live for the customer at the message time sends
 -- the C1 call to review as before. The job's insert runs P1b's
 -- reconsideration (rules on), which re-decides the stored row.
 PERFORM pg_temp.hp_flag(true);
 jn:=pg_temp.hp_job('SWF-992026','hp-cust','scheduled',interval '1 day');
 SELECT * INTO r FROM public.business_events WHERE source='ghl-call-transcript' AND contact_id='hp-cust';
 IF r.job_id IS NOT NULL OR r.attribution_status NOT IN ('pending_luna','unplaced') OR NOT (jn=ANY(r.candidate_job_ids))
  OR NOT (ji=ANY(r.candidate_job_ids)) OR r.metadata ? 'placement_held_from'
 THEN RAISE EXCEPTION 'l1f C5: with a new live job the call must go to review, got % % %',r.attribution_status,r.job_id,r.candidate_job_ids; END IF;
 -- C6. Control: a row a reference placed (direct) is not a contact-rule row.
 PERFORM pg_temp.hp_flag(false);
 e:=pg_temp.hp_ev('ghl-message-reconcile','client.sms_in',NULL,NULL,'{"body":"About SWF-992021 please"}','sms','inbound','hp-ref');
 IF e.job_id IS DISTINCT FROM jold OR e.attribution_status<>'direct' THEN RAISE EXCEPTION 'l1f C6: the reference must place, got % %',e.attribution_status,e.job_id; END IF;
 PERFORM pg_temp.hp_flag(true);
 r:=pg_temp.hp_decide(e.id,'C6');
 IF r.metadata ? 'placement_held_from' THEN RAISE EXCEPTION 'l1f C6: a reference placement must not be held, got %',r.metadata; END IF;
 PERFORM pg_temp.hp_flag(false);
END $$;

BEGIN;
SELECT pg_temp.hp_cases();
ROLLBACK;

-- D. Structure.
-- A registered successor (L1g 20261006035000) replaces the rules ladder and
-- proves in its own contract that its body is exactly this one plus its
-- edits; while it is live only the untouched functions, the grants and the
-- flag are checked here, and the re-apply is skipped (L1f's guard refuses to
-- re-apply over L1g's body).
SELECT coalesce(obj_description(to_regprocedure('public.resolve_context_attribution(public.business_events,boolean,boolean)'),'pg_proc'),'') LIKE 'L1g:%' AS l1g_live \gset
\if :l1g_live
DO $$
DECLARE r text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ladder_p1a(public.business_events,boolean)'::regprocedure)<>'ce620833c851196a00eca328d9b7426a'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events)'::regprocedure)<>'32365101d23dde1695707a0bddff640b'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.attribute_business_event()'::regprocedure)<>'d0036a1bc36f4b2a779f4a8b192cd687'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_contact_job_timeline(text,timestamptz,text,text)'::regprocedure)<>'f98da204718a4d5ac6395761a963ced4'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_attribution_preview(uuid,boolean)'::regprocedure)<>'4cd4ef761039f754138518a90531ecd2'
 THEN RAISE EXCEPTION 'l1f: the rules-off ladder, the entry, the trigger, the timeline or the preview changed'; END IF;
 IF coalesce(obj_description('public.context_ladder_p1a(public.business_events,boolean)'::regprocedure,'pg_proc'),'') NOT LIKE 'L1e:%'
 THEN RAISE EXCEPTION 'l1f: the rules-off ladder must stay L1e'; END IF;
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_function_privilege(r,'public.resolve_context_attribution(public.business_events,boolean,boolean)','EXECUTE')
  THEN RAISE EXCEPTION 'l1f: % can call the private rules ladder',r; END IF;
 END LOOP;
 IF (SELECT count(*) FROM public.feature_flags WHERE flag_name='context_unlinked_rules_v1' AND NOT enabled)<>1
 THEN RAISE EXCEPTION 'l1f: the rules flag must stay off'; END IF;
END $$;
\else
DO $$
DECLARE r text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure)<>'0870431e8ec3ab2f2e123146298c9727'
 THEN RAISE EXCEPTION 'l1f: the rules ladder is not this migration''s'; END IF;
 -- Undoing the L1f edits gives back L1e's body byte for byte.
 IF md5(replace(replace(replace(replace(replace(replace(replace(replace((SELECT prosrc FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure),
$b$ writer_job uuid;
 held_job uuid; held_conf numeric; held_match_conf numeric; held_ok boolean:=false; all_ids uuid[]; own_live_ids uuid[];
BEGIN
 rules_on:=$b$,
$b$ writer_job uuid;
BEGIN
 rules_on:=$b$),
$b$  'audience','recipient_role_source','placement_held_from'];$b$,
$b$  'audience','recipient_role_source'];$b$),
$b$    ELSE
     -- L1e (20261005170000): a job the service role named without saying how
     -- (no match_method) is kept for a row the reader never reads.
     writer_job:=public.context_event_writer_job(e);
     -- L1f (20261006020000): a job a contact rule or Luna already chose
     -- (single_open, single_line or luna, match_method contact_id) is
     -- remembered for the held placement at step 5.
     IF prior_status IN ('single_open','single_line','luna') AND source_method='contact_id' THEN
      held_job:=e.job_id; held_conf:=e.attribution_confidence; held_match_conf:=e.match_confidence;
     END IF;
$b$,
$b$    ELSE
     -- L1e (20261005170000): a job the service role named without saying how
     -- (no match_method) is kept for a row the reader never reads.
     writer_job:=public.context_event_writer_job(e);
$b$),
$b$   ELSIF writer<>'service_role' THEN
    -- L1f (20261006020000): a row the reader never reads (system or audit,
    -- no words, automated) keeps a custody job the service role confirmed
    -- after the insert (source_job_binding.via, written only by a reviewed
    -- service-role repair such as writer_key_relink: the insert trigger strips
    -- any binding a writer sends, and no other role may update the row), as
    -- with the rules off. Every worded row from this writer is still held.
    IF e.job_id IS NOT NULL AND e.metadata->'source_job_binding' ? 'via'
     AND (to_jsonb(e)->>'channel' IN ('system','audit') OR btrim(words)='' OR prior_status='automated'
      OR e.payload->>'automated'='true' OR e.payload->>'auto_submitted' IN ('auto-generated','auto-replied')) THEN
     e.attribution_status:=CASE WHEN to_jsonb(e)->>'channel' IN ('system','audit') THEN 'automated' WHEN btrim(words)='' THEN 'empty' ELSE 'automated' END;
     e.metadata:=e.metadata||jsonb_build_object('placement_rule','confirmed_custody');
     EXIT rules;
    END IF;
    IF e.job_id IS NOT NULL THEN$b$,
$b$   ELSIF writer<>'service_role' THEN
    IF e.job_id IS NOT NULL THEN$b$),
$b$      AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '60 days'),'{}'),
     coalesce(array_agg(t.job_id ORDER BY t.job_id) FILTER (WHERE t.basis<>'key_other_contact'),'{}'),
     coalesce(array_agg(t.job_id ORDER BY t.job_id) FILTER (WHERE t.basis<>'key_other_contact' AND t.candidate),'{}')
    INTO ids,line_ids,guard_ids,contactless_ids,other_ids,used_updated_at,unpaid_ids,window_ids,all_ids,own_live_ids
    FROM public.context_contact_job_timeline(contact,v_at,pk,ek) t;
    -- L1f (20261006020000): the held job is still the answer while it is one
    -- of the customer's own or contactless jobs and no other of those is live
    -- at the message time (none is, or it is the one). Another contact's job
    -- that shares the phone or email is not the customer's job.
    held_ok:=held_job IS NOT NULL AND held_job=ANY(all_ids)
     AND (cardinality(own_live_ids)=0 OR own_live_ids=ARRAY[held_job]);
   END IF;
$b$,
$b$      AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '60 days'),'{}')
    INTO ids,line_ids,guard_ids,contactless_ids,other_ids,used_updated_at,unpaid_ids,window_ids
    FROM public.context_contact_job_timeline(contact,v_at,pk,ek) t;
   END IF;
$b$),
$b$    IF FOUND AND b.retired_at IS NOT NULL THEN
     -- L1f (20261006020000): a held row goes on to step 5 and stays.
     IF NOT held_ok THEN
      e.attribution_status:='unplaced'; e.attribution_step:=2;
      e.candidate_job_ids:=ARRAY(SELECT DISTINCT x FROM unnest(ARRAY[b.job_id,b.retired_conflict_job_id]) x WHERE x IS NOT NULL ORDER BY x);
      e.metadata:=e.metadata||jsonb_build_object('placement_rule','thread_retired','placement_retired_binding',e.thread_key);
      EXIT rules;
     END IF;
    ELSIF$b$,
$b$    IF FOUND AND b.retired_at IS NOT NULL THEN
     e.attribution_status:='unplaced'; e.attribution_step:=2;
     e.candidate_job_ids:=ARRAY(SELECT DISTINCT x FROM unnest(ARRAY[b.job_id,b.retired_conflict_job_id]) x WHERE x IS NOT NULL ORDER BY x);
     e.metadata:=e.metadata||jsonb_build_object('placement_rule','thread_retired','placement_retired_binding',e.thread_key);
     EXIT rules;
    ELSIF$b$),
$b$      e.metadata:=e.metadata||jsonb_build_object('aftercare_unpaid_job_ids',to_jsonb(unpaid_ids));
     END IF;
    END IF;
    -- L1f (20261006020000): held placement. A row a contact rule or Luna
    -- already put on a job keeps it when the rules above would send it to
    -- review or the bucket and no other job of the customer (own or
    -- contactless) is live at the message time: the rules-on reasons (an invoiced job counted finished,
    -- aftercare, a shared phone or email, a recently finished job) never take
    -- it off its job. With another live job (P1b's reconsideration after a
    -- new job) the rules above decide as before. placement_held_from names
    -- the rule it outranked.
    IF cand IS NULL AND held_ok THEN
     e.metadata:=e.metadata||jsonb_build_object('placement_held_from',coalesce(rule,CASE WHEN contact IS NULL THEN 'no_contact' ELSE 'no_candidate_at_time' END));
     cand:=held_job; e.attribution_status:=prior_status;
     e.attribution_step:=CASE prior_status WHEN 'single_open' THEN 3 WHEN 'single_line' THEN 4 ELSE 5 END;
     rule:='held_placement'; review_ids:=NULL;
    END IF;
    IF review_ids IS NOT NULL THEN
     -- Rows loaded as history or re-links never go to the model (X27).$b$,
$b$      e.metadata:=e.metadata||jsonb_build_object('aftercare_unpaid_job_ids',to_jsonb(unpaid_ids));
     END IF;
    END IF;
    IF review_ids IS NOT NULL THEN
     -- Rows loaded as history or re-links never go to the model (X27).$b$),
$b$   e.metadata:=e.metadata||jsonb_build_object('placement_rule',rule);
   e.attribution_confidence:=CASE WHEN rule='held_placement' THEN coalesce(held_conf,1) ELSE 1 END; e.attributed_at:=clock_timestamp();
   e.match_status:='matched'; e.match_confidence:=CASE WHEN rule='held_placement' THEN coalesce(held_match_conf,1) ELSE 1 END;$b$,
$b$   e.metadata:=e.metadata||jsonb_build_object('placement_rule',rule);
   e.attribution_confidence:=1; e.attributed_at:=clock_timestamp();
   e.match_status:='matched'; e.match_confidence:=1;$b$))<>'d5af94a0f9320652116cc2b304021ab5'
 THEN RAISE EXCEPTION 'l1f: the rules ladder is not L1e''s body plus the L1f edits'; END IF;
 -- The rules-off ladder, the entry, the insert trigger, the timeline and the preview are untouched.
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ladder_p1a(public.business_events,boolean)'::regprocedure)<>'ce620833c851196a00eca328d9b7426a'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events)'::regprocedure)<>'32365101d23dde1695707a0bddff640b'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.attribute_business_event()'::regprocedure)<>'d0036a1bc36f4b2a779f4a8b192cd687'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_contact_job_timeline(text,timestamptz,text,text)'::regprocedure)<>'f98da204718a4d5ac6395761a963ced4'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_attribution_preview(uuid,boolean)'::regprocedure)<>'4cd4ef761039f754138518a90531ecd2'
 THEN RAISE EXCEPTION 'l1f: the rules-off ladder, the entry, the trigger, the timeline or the preview changed'; END IF;
 IF coalesce(obj_description('public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure,'pg_proc'),'') NOT LIKE 'L1f:%'
  OR coalesce(obj_description('public.context_ladder_p1a(public.business_events,boolean)'::regprocedure,'pg_proc'),'') NOT LIKE 'L1e:%'
 THEN RAISE EXCEPTION 'l1f: the rules ladder must be marked L1f and the rules-off ladder stay L1e'; END IF;
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_function_privilege(r,'public.resolve_context_attribution(public.business_events,boolean,boolean)','EXECUTE')
  THEN RAISE EXCEPTION 'l1f: % can call the private rules ladder',r; END IF;
 END LOOP;
 IF NOT has_function_privilege('service_role','public.resolve_context_attribution(public.business_events)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.context_attribution_preview(uuid,boolean)','EXECUTE')
 THEN RAISE EXCEPTION 'l1f: the service role lost the ladder entry or the preview'; END IF;
 IF (SELECT count(*) FROM public.feature_flags WHERE flag_name='context_unlinked_rules_v1' AND NOT enabled)<>1
 THEN RAISE EXCEPTION 'l1f: the rules flag must stay off'; END IF;
END $$;

-- Re-apply is a no-op.
CREATE TEMP TABLE l1f_before AS SELECT md5(p.prosrc) AS md5, obj_description(p.oid,'pg_proc') AS note
 FROM pg_proc p WHERE p.oid='public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure;
\ir ../../../migrations/20261006020000_context_ladder_held_placement.sql
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM l1f_before b, pg_proc p WHERE p.oid='public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure
   AND (md5(p.prosrc) IS DISTINCT FROM b.md5 OR obj_description(p.oid,'pg_proc') IS DISTINCT FROM b.note))
 THEN RAISE EXCEPTION 'l1f: re-apply changed the body or comment'; END IF;
END $$;
DROP TABLE l1f_before;
\endif
