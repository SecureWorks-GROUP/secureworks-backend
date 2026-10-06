-- Ladder L1g contract (20261006035000). Every fixture write is rolled back.
-- Ids, job numbers, contacts, phones, invoice numbers and text are synthetic.
--
-- Each row is decided through the stored row: the preview and a real
-- re-decision (the one-argument entry, which reads the flag) must agree.
--   A. The re-quote shape (P4 preview 6 Oct, SWF-261501). A customer with a
--      quoted job calls; six minutes later a second job card is made as a
--      draft; five minutes after that we text the customer; the draft is
--      quoted later. Both rows were placed single_open on the first job (a
--      draft beside a live job is not a candidate, and the draft's insert
--      reopened nothing for that reason). With the rules on, a re-decision
--      keeps both rows on their job (held_placement, held from
--      review_several). Control: a new job inserted live still reopens both
--      rows to review through P1b, as before.
--   B. A row Luna placed on one of two live jobs keeps it with the rules on.
--   C. A row Luna placed on a job finished 20 days before the message (the
--      review offered it beside the live job) keeps it with the rules on.
--   D. Controls, decided as before: a row on a job finished long before the
--      message while another job is live moves to the live job (single_open);
--      a row whose job now belongs to another contact moves to the
--      customer's job; a single_line placement by the row's own line outranks
--      the held job.
--   E. The history shape (P4 preview 6 Oct, SWP-26040): a history-loaded text
--      naming the invoice of a job that was live when it was sent (completed
--      the next day, archived since) is placed direct on that job with the
--      rules on, as with L1f. L1g does not change references.
--   F. Structure: the body is L1f's plus exactly these edits, the rules-off
--      ladder, the entry, the insert trigger, the timeline, the preview and
--      P1b are untouched, the body is private and marked L1g, the flag stays
--      off, and a re-apply is a no-op.
--   G. A contactless job the rules-off ladder cannot see (6 Oct: 51 contact-
--      rule rows of 3 customers in the last 30 days). The rules-off ladder
--      reads only the own jobs' phone and email, so it places the text
--      single_open on the own job; the rules also read the message's own
--      phone, find a job card with no contact live as well, and keep the row
--      where it is. A fresh text of the same shape still goes to review: the
--      hold keeps a past decision, it never makes a new one.
\set ON_ERROR_STOP 1

CREATE FUNCTION pg_temp.hl_job(p_number text,p_contact text,p_status text,p_type text,p_created interval,p_completed interval DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at,completed_at)
  VALUES(j,'00000000-0000-0000-0000-000000000001',p_status,p_type,p_number,p_contact,now()-p_created,now()-p_completed);
 RETURN j;
END $$;

-- One record through the real insert trigger (service role writer).
CREATE FUNCTION pg_temp.hl_ev(p_source text,p_event text,p_payload jsonb,p_channel text,p_direction text,p_contact text,
 p_at interval,p_mode text DEFAULT 'live')
RETURNS public.business_events LANGUAGE plpgsql AS $$
DECLARE e public.business_events;
BEGIN
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 INSERT INTO public.business_events(contact_id,entity_type,entity_id,direction,channel,event_type,source,
  provider_message_id,payload,metadata,occurred_at,event_at)
  VALUES(p_contact,'contact',p_contact,p_direction,p_channel,p_event,p_source,
   'ghl:hl'||replace(gen_random_uuid()::text,'-',''),p_payload,jsonb_build_object('capture_mode',p_mode),now()-p_at,now()-p_at)
  RETURNING * INTO e;
 PERFORM set_config('request.jwt.claims','',true);
 RETURN e;
END $$;

CREATE FUNCTION pg_temp.hl_flag(p_on boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 UPDATE public.feature_flags SET enabled=p_on,updated_at=clock_timestamp() WHERE flag_name='context_unlinked_rules_v1';
 IF public.context_unlinked_rules_enabled() IS DISTINCT FROM p_on THEN RAISE EXCEPTION 'l1g fixture: flag not %',p_on; END IF;
END $$;

-- What the ladder decides for a stored row with the flag as it is: the
-- preview (rules forced to the flag) and a real re-decision must agree.
CREATE FUNCTION pg_temp.hl_decide(p_id uuid,p_label text) RETURNS public.business_events LANGUAGE plpgsql AS $$
DECLARE e public.business_events; r public.business_events; p jsonb;
BEGIN
 SELECT * INTO e FROM public.business_events WHERE id=p_id;
 p:=public.context_attribution_preview(p_id,public.context_unlinked_rules_enabled());
 r:=public.resolve_context_attribution(e);
 IF p->'decided'->>'job_id' IS DISTINCT FROM r.job_id::text OR p->'decided'->>'attribution_status' IS DISTINCT FROM r.attribution_status
  OR p->'decided'->>'placement_rule' IS DISTINCT FROM r.metadata->>'placement_rule'
 THEN RAISE EXCEPTION 'l1g %: the preview and the re-decision disagree: % vs % % %',p_label,p->'decided',r.attribution_status,r.job_id,r.metadata->>'placement_rule'; END IF;
 RETURN r;
END $$;

-- G, on its own so a failing-first run can call it alone.
CREATE FUNCTION pg_temp.hl_case_g() RETURNS void LANGUAGE plpgsql AS $$
DECLARE ga uuid:=gen_random_uuid(); gb uuid:=gen_random_uuid(); e public.business_events; r public.business_events;
BEGIN
 PERFORM pg_temp.hl_flag(false);
 -- The customer's own job carries one phone; a job card with no contact
 -- carries the phone the texts come from.
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,client_phone,created_at) VALUES
  (ga,'00000000-0000-0000-0000-000000000001','quoted','fencing','SWF-993071','hl-sibling','0491 570 156',now()-interval '20 days'),
  (gb,'00000000-0000-0000-0000-000000000001','scheduled','fencing','SWF-993072',NULL,'0491 570 157',now()-interval '10 days');
 e:=pg_temp.hl_ev('ghl-message-reconcile','client.sms_in','{"body":"Running ten minutes late","phone":"0491 570 157"}','sms','inbound','hl-sibling',interval '2 days');
 IF e.job_id IS DISTINCT FROM ga OR e.attribution_status<>'single_open'
 THEN RAISE EXCEPTION 'l1g G: with the rules off the text must land single_open on the own job, got % %',e.attribution_status,e.job_id; END IF;
 PERFORM pg_temp.hl_flag(true);
 r:=pg_temp.hl_decide(e.id,'G');
 IF r.job_id IS DISTINCT FROM ga OR r.attribution_status<>'single_open' OR r.match_method<>'contact_id'
  OR r.metadata->>'placement_rule' IS DISTINCT FROM 'held_placement' OR r.metadata->>'placement_held_from' IS DISTINCT FROM 'review_several'
 THEN RAISE EXCEPTION 'l1g G rules on: a row placed before the rules could see the contactless job must keep its job, got % % % %',
  r.attribution_status,r.job_id,r.metadata->>'placement_rule',r.metadata->>'placement_held_from'; END IF;
 -- Control: the same text decided fresh with the rules on goes to review
 -- with both jobs; nothing was held for it.
 e:=pg_temp.hl_ev('ghl-message-reconcile','client.sms_in','{"body":"Running ten minutes late","phone":"0491 570 157"}','sms','inbound','hl-sibling',interval '1 day');
 IF e.job_id IS NOT NULL OR e.attribution_status<>'pending_luna' OR e.metadata->>'placement_rule' IS DISTINCT FROM 'review_several'
  OR NOT (ga=ANY(e.candidate_job_ids)) OR NOT (gb=ANY(e.candidate_job_ids))
 THEN RAISE EXCEPTION 'l1g G: a fresh text with both jobs live must go to review, got % % % %',
  e.attribution_status,e.job_id,e.metadata->>'placement_rule',e.candidate_job_ids; END IF;
 PERFORM pg_temp.hl_flag(false);
END $$;

CREATE FUNCTION pg_temp.hl_cases() RETURNS void LANGUAGE plpgsql AS $$
DECLARE ja uuid; jb uuid; jc uuid; ka uuid; kb uuid; kc uuid; kd uuid; ke uuid; kf uuid; kg uuid; kh uuid; ki uuid; kj uuid; kk uuid;
 call public.business_events; txt public.business_events; e public.business_events; r public.business_events;
BEGIN
 ---------------------------------------------------------------- A. the re-quote shape
 PERFORM pg_temp.hl_flag(false);
 ja:=pg_temp.hl_job('SWF-993001','hl-requote','quoted','fencing',interval '4 days');
 -- The customer calls about the quote (90 minutes ago).
 call:=pg_temp.hl_ev('ghl-call-transcript','call.transcript_completed','{"transcript":"Calling about the quote you sent"}',
  'call','inbound','hl-requote',interval '90 minutes');
 IF call.job_id IS DISTINCT FROM ja OR call.attribution_status<>'single_open'
 THEN RAISE EXCEPTION 'l1g A: the call must land single_open on the quoted job, got % %',call.attribution_status,call.job_id; END IF;
 -- Six minutes later a second job card is made as a draft. Its insert runs
 -- P1b, which reopens nothing: a draft beside a live job is not a candidate.
 jb:=pg_temp.hl_job('SWF-993002','hl-requote','draft','fencing',interval '84 minutes');
 SELECT * INTO e FROM public.business_events WHERE id=call.id;
 IF e.job_id IS DISTINCT FROM ja OR e.attribution_status<>'single_open'
 THEN RAISE EXCEPTION 'l1g A: the draft''s insert must leave the call on its job, got % %',e.attribution_status,e.job_id; END IF;
 -- Five minutes after that we text the customer; the draft does not count.
 txt:=pg_temp.hl_ev('ghl-message-reconcile','client.sms_out','{"body":"Please send a few photos of the fence line"}',
  'sms','outbound','hl-requote',interval '79 minutes');
 IF txt.job_id IS DISTINCT FROM ja OR txt.attribution_status<>'single_open'
 THEN RAISE EXCEPTION 'l1g A: the text must land single_open on the quoted job, got % %',txt.attribution_status,txt.job_id; END IF;
 -- The draft is quoted later. Nothing reopens rows when a draft goes live.
 UPDATE public.jobs SET status='quoted' WHERE id=jb;
 PERFORM pg_temp.hl_flag(true);
 r:=pg_temp.hl_decide(call.id,'A call');
 IF r.job_id IS DISTINCT FROM ja OR r.attribution_status<>'single_open' OR r.match_method<>'contact_id'
  OR r.metadata->>'placement_rule' IS DISTINCT FROM 'held_placement' OR r.metadata->>'placement_held_from' IS DISTINCT FROM 'review_several'
 THEN RAISE EXCEPTION 'l1g A rules on: a row placed before the customer''s draft went live must keep its job, got % % % %',
  r.attribution_status,r.job_id,r.metadata->>'placement_rule',r.metadata->>'placement_held_from'; END IF;
 r:=pg_temp.hl_decide(txt.id,'A text');
 IF r.job_id IS DISTINCT FROM ja OR r.attribution_status<>'single_open'
  OR r.metadata->>'placement_rule' IS DISTINCT FROM 'held_placement' OR r.metadata->>'placement_held_from' IS DISTINCT FROM 'review_several'
 THEN RAISE EXCEPTION 'l1g A rules on: a row placed while the second job was a draft must keep its job, got % % % %',
  r.attribution_status,r.job_id,r.metadata->>'placement_rule',r.metadata->>'placement_held_from'; END IF;
 -- Control: a new job inserted live still reopens both rows to review
 -- through P1b, with every candidate at their time (L1g holds nothing there).
 jc:=pg_temp.hl_job('SWF-993003','hl-requote','scheduled','fencing',interval '1 minute');
 FOREACH e IN ARRAY ARRAY(SELECT b FROM public.business_events b WHERE b.id IN (call.id,txt.id)) LOOP
  IF e.job_id IS NOT NULL OR e.attribution_status<>'pending_luna' OR e.metadata->>'placement_rule' IS DISTINCT FROM 'reopen_new_job'
   OR NOT (jc=ANY(e.candidate_job_ids)) OR NOT (ja=ANY(e.candidate_job_ids))
  THEN RAISE EXCEPTION 'l1g A: a new live job must still reopen the row to review, got % % % %',e.attribution_status,e.job_id,e.metadata->>'placement_rule',e.candidate_job_ids; END IF;
 END LOOP;

 ---------------------------------------------------------------- B. Luna chose one of two live jobs
 PERFORM pg_temp.hl_flag(false);
 ka:=pg_temp.hl_job('SWF-993011','hl-luna','quoted','fencing',interval '20 days');
 kb:=pg_temp.hl_job('SWP-993012','hl-luna','scheduled','patio',interval '15 days');
 e:=pg_temp.hl_ev('ghl-message-reconcile','client.sms_in','{"body":"Can the crew start a bit later tomorrow?"}','sms','inbound','hl-luna',interval '2 days');
 IF e.job_id IS NOT NULL OR e.attribution_status<>'pending_luna' OR NOT (kb=ANY(e.candidate_job_ids))
 THEN RAISE EXCEPTION 'l1g B: two live jobs must send the text to Luna, got % % %',e.attribution_status,e.job_id,e.candidate_job_ids; END IF;
 e:=public.attribute_context_event_with_luna(e.id,kb,0.9,'job');
 IF e.job_id IS DISTINCT FROM kb OR e.attribution_status<>'luna' OR e.match_method<>'contact_id'
 THEN RAISE EXCEPTION 'l1g B: Luna must place the text, got % %',e.attribution_status,e.job_id; END IF;
 PERFORM pg_temp.hl_flag(true);
 r:=pg_temp.hl_decide(e.id,'B');
 IF r.job_id IS DISTINCT FROM kb OR r.attribution_status<>'luna' OR r.attribution_confidence IS DISTINCT FROM 0.9
  OR r.metadata->>'placement_rule' IS DISTINCT FROM 'held_placement' OR r.metadata->>'placement_held_from' IS DISTINCT FROM 'review_several'
 THEN RAISE EXCEPTION 'l1g B rules on: a row Luna placed on one of two live jobs must keep it, got % % % %',
  r.attribution_status,r.job_id,r.metadata->>'placement_rule',r.attribution_confidence; END IF;

 ---------------------------------------------------------------- C. Luna chose a recently finished job
 PERFORM pg_temp.hl_flag(true);
 kc:=pg_temp.hl_job('SWF-993021','hl-after','complete','fencing',interval '120 days',interval '22 days');
 kd:=pg_temp.hl_job('SWP-993022','hl-after','quoted','patio',interval '10 days');
 e:=pg_temp.hl_ev('ghl-message-reconcile','client.sms_in','{"body":"One of the gate hinges is squeaking"}','sms','inbound','hl-after',interval '2 days');
 IF e.job_id IS NOT NULL OR e.attribution_status<>'pending_luna' OR e.metadata->>'placement_rule' IS DISTINCT FROM 'review_recent_other_job'
  OR NOT (kc=ANY(e.candidate_job_ids))
 THEN RAISE EXCEPTION 'l1g C: a live job and a recently finished one must send the text to Luna, got % % % %',
  e.attribution_status,e.job_id,e.metadata->>'placement_rule',e.candidate_job_ids; END IF;
 e:=public.attribute_context_event_with_luna(e.id,kc,0.95,'job');
 IF e.job_id IS DISTINCT FROM kc OR e.attribution_status<>'luna' THEN RAISE EXCEPTION 'l1g C: Luna must place the text, got % %',e.attribution_status,e.job_id; END IF;
 r:=pg_temp.hl_decide(e.id,'C');
 IF r.job_id IS DISTINCT FROM kc OR r.attribution_status<>'luna'
  OR r.metadata->>'placement_rule' IS DISTINCT FROM 'held_placement' OR r.metadata->>'placement_held_from' IS DISTINCT FROM 'review_recent_other_job'
 THEN RAISE EXCEPTION 'l1g C rules on: a row Luna placed on a recently finished job must keep it, got % % %',
  r.attribution_status,r.job_id,r.metadata->>'placement_rule'; END IF;

 ---------------------------------------------------------------- D. controls (decided as before)
 -- D1. A row on a job finished long before the message, another job live:
 -- the rules place it on the live job.
 PERFORM pg_temp.hl_flag(false);
 ke:=pg_temp.hl_job('SWF-993031','hl-old','complete','fencing',interval '400 days',interval '300 days');
 kf:=pg_temp.hl_job('SWF-993032','hl-old','scheduled','fencing',interval '20 days');
 e:=pg_temp.hl_ev('ghl-message-reconcile','client.sms_in','{"body":"What time will the crew arrive?"}','sms','inbound','hl-old',interval '2 days');
 UPDATE public.business_events SET job_id=ke,attribution_status='single_open',attribution_step=3,match_method='contact_id',
  match_status='matched',match_confidence=1,attribution_confidence=1,attributed_at=now(),candidate_job_ids=NULL
 WHERE id=e.id RETURNING * INTO e;
 PERFORM pg_temp.hl_flag(true);
 r:=pg_temp.hl_decide(e.id,'D1');
 IF r.job_id IS DISTINCT FROM kf OR r.attribution_status<>'single_open' OR r.metadata ? 'placement_held_from'
 THEN RAISE EXCEPTION 'l1g D1: a row on a long-finished job must move to the live job, got % % %',r.attribution_status,r.job_id,r.metadata->>'placement_rule'; END IF;
 -- D2. A row whose job now belongs to another contact: the customer's job.
 PERFORM pg_temp.hl_flag(false);
 kg:=pg_temp.hl_job('SWF-993041','hl-moved','quoted','fencing',interval '20 days');
 e:=pg_temp.hl_ev('ghl-message-reconcile','client.sms_in','{"body":"Thanks for the quote"}','sms','inbound','hl-moved',interval '2 days');
 IF e.job_id IS DISTINCT FROM kg THEN RAISE EXCEPTION 'l1g D2: the text must land on the customer''s job, got %',e.job_id; END IF;
 kh:=pg_temp.hl_job('SWF-993042','hl-moved','quoted','fencing',interval '20 days');
 UPDATE public.jobs SET ghl_contact_id='hl-moved-other' WHERE id=kg;
 PERFORM pg_temp.hl_flag(true);
 r:=pg_temp.hl_decide(e.id,'D2');
 IF r.job_id IS DISTINCT FROM kh OR r.metadata ? 'placement_held_from'
 THEN RAISE EXCEPTION 'l1g D2: a row whose job moved to another contact must not be held, got % % %',r.attribution_status,r.job_id,r.metadata->>'placement_rule'; END IF;
 -- D3. The row's own line picks the other live job: single_line outranks.
 PERFORM pg_temp.hl_flag(false);
 ki:=pg_temp.hl_job('SWF-993051','hl-line','quoted','fencing',interval '20 days');
 e:=pg_temp.hl_ev('ghl-message-reconcile','client.sms_in','{"body":"Is the patio roof colour locked in?","line":"patio"}','sms','inbound','hl-line',interval '2 days');
 IF e.job_id IS DISTINCT FROM ki THEN RAISE EXCEPTION 'l1g D3: the text must land on the only job, got %',e.job_id; END IF;
 kj:=pg_temp.hl_job('SWP-993052','hl-line','quoted','patio',interval '1 day');
 -- The patio job's insert reopened the row (P1b); put it back as it stood.
 UPDATE public.business_events SET job_id=ki,attribution_status='single_open',attribution_step=3,match_method='contact_id',
  match_status='matched',match_confidence=1,attribution_confidence=1,attributed_at=now(),candidate_job_ids=NULL
 WHERE id=e.id RETURNING * INTO e;
 PERFORM pg_temp.hl_flag(true);
 r:=pg_temp.hl_decide(e.id,'D3');
 IF r.job_id IS DISTINCT FROM kj OR r.attribution_status<>'single_line' OR r.metadata ? 'placement_held_from'
 THEN RAISE EXCEPTION 'l1g D3: the row''s own line must outrank the held job, got % % %',r.attribution_status,r.job_id,r.metadata->>'placement_rule'; END IF;

 ---------------------------------------------------------------- E. the history shape (references unchanged)
 PERFORM pg_temp.hl_flag(false);
 kj:=pg_temp.hl_job('SWP-993061','hl-history','archived','patio',interval '190 days',interval '119 days');
 kk:=pg_temp.hl_job('SWP-993062','hl-history','quoted','patio',interval '150 days');
 INSERT INTO public.xero_invoices(org_id,xero_invoice_id,invoice_number,invoice_type,status,job_id,total,amount_due,amount_paid,invoice_date)
  VALUES('00000000-0000-0000-0000-000000000001','hl-inv-993061','INV-993061','ACCREC','PAID',kj,1000,0,1000,(now()-interval '125 days')::date);
 e:=pg_temp.hl_ev('ghl-history-load','client.reply','{"body":"Paid INV-993061 today, receipt 4471"}','sms','inbound','hl-history',interval '120 days','backfill');
 PERFORM pg_temp.hl_flag(true);
 r:=pg_temp.hl_decide(e.id,'E');
 IF r.job_id IS DISTINCT FROM kj OR r.attribution_status<>'direct' OR r.metadata->>'placement_rule' IS DISTINCT FROM 'direct_ref'
 THEN RAISE EXCEPTION 'l1g E: a text naming the invoice of a job live when it was sent must be placed on it, got % % %',
  r.attribution_status,r.job_id,r.metadata->>'placement_rule'; END IF;
 -- That job was live at the message time (finished the next day).
 IF NOT EXISTS (SELECT 1 FROM public.context_contact_job_timeline('hl-history',now()-interval '120 days',NULL,NULL) t WHERE t.job_id=kj AND t.candidate)
 THEN RAISE EXCEPTION 'l1g E: the invoiced job must be live at the message time'; END IF;

 ---------------------------------------------------------------- G. a contactless job the rules-off ladder cannot see
 PERFORM pg_temp.hl_case_g();
 PERFORM pg_temp.hl_flag(false);
END $$;

BEGIN;
SELECT pg_temp.hl_cases();
ROLLBACK;

-- F. Structure.
DO $$
DECLARE r text;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure)<>'0faf9b6362c35225b8eca7beba887d99'
 THEN RAISE EXCEPTION 'l1g: the rules ladder is not this migration''s'; END IF;
 -- Undoing the L1g edits gives back L1f's body byte for byte.
 IF md5(replace(replace((SELECT prosrc FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure),
$b$    -- L1f (20261006020000): the held job is still the answer while it is one
    -- of the customer's own or contactless jobs and none of those is live at
    -- the message time. Another contact's job that shares the phone or email
    -- is not the customer's job.
    -- L1g (20261006035000): it is also the answer while it is itself one of
    -- those jobs live at the message time, or one the review would offer
    -- (finished in the guard window, unpaid, or in the aftercare window),
    -- whatever other job of the customer is live then. The decision made when
    -- the row was placed stands: a newer job reopens a placed row only through
    -- P1b at its insert (context_reconsider_contact, the one reopen path), and
    -- a job that was a draft then and went live later reopens nothing.
    held_ok:=held_job IS NOT NULL AND held_job=ANY(all_ids)
     AND (cardinality(own_live_ids)=0 OR held_job=ANY(own_live_ids||guard_ids||unpaid_ids||window_ids));
$b$,
$b$    -- L1f (20261006020000): the held job is still the answer while it is one
    -- of the customer's own or contactless jobs and no other of those is live
    -- at the message time (none is, or it is the one). Another contact's job
    -- that shares the phone or email is not the customer's job.
    held_ok:=held_job IS NOT NULL AND held_job=ANY(all_ids)
     AND (cardinality(own_live_ids)=0 OR own_live_ids=ARRAY[held_job]);
$b$),
$b$    -- L1f (20261006020000): held placement. A row a contact rule or Luna
    -- already put on a job keeps it when the rules above would send it to
    -- review or the bucket and its job is still the answer (held_ok, set with
    -- the candidates): the rules-on reasons (an invoiced job counted finished,
    -- aftercare, a shared phone or email, a recently finished job and, since
    -- L1g, another live job of the customer) never take it off its job. A
    -- placement the rules above make is not outranked. placement_held_from
    -- names the rule it outranked.
$b$,
$b$    -- L1f (20261006020000): held placement. A row a contact rule or Luna
    -- already put on a job keeps it when the rules above would send it to
    -- review or the bucket and no other job of the customer (own or
    -- contactless) is live at the message time: the rules-on reasons (an invoiced job counted finished,
    -- aftercare, a shared phone or email, a recently finished job) never take
    -- it off its job. With another live job (P1b's reconsideration after a
    -- new job) the rules above decide as before. placement_held_from names
    -- the rule it outranked.
$b$))<>'0870431e8ec3ab2f2e123146298c9727'
 THEN RAISE EXCEPTION 'l1g: the rules ladder is not L1f''s body plus the L1g edits'; END IF;
 -- The rules-off ladder, the entry, the insert trigger, the timeline, the
 -- preview and P1b's reconsideration are untouched.
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ladder_p1a(public.business_events,boolean)'::regprocedure)<>'ce620833c851196a00eca328d9b7426a'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events)'::regprocedure)<>'32365101d23dde1695707a0bddff640b'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.attribute_business_event()'::regprocedure)<>'d0036a1bc36f4b2a779f4a8b192cd687'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_contact_job_timeline(text,timestamptz,text,text)'::regprocedure)<>'f98da204718a4d5ac6395761a963ced4'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_attribution_preview(uuid,boolean)'::regprocedure)<>'4cd4ef761039f754138518a90531ecd2'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_reconsider_contact(text,timestamptz,text,uuid)'::regprocedure)<>'5f9dbe883f0add7a6987f3ed265a08af'
 THEN RAISE EXCEPTION 'l1g: the rules-off ladder, the entry, the trigger, the timeline, the preview or P1b changed'; END IF;
 IF coalesce(obj_description('public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure,'pg_proc'),'') NOT LIKE 'L1g:%'
  OR coalesce(obj_description('public.context_ladder_p1a(public.business_events,boolean)'::regprocedure,'pg_proc'),'') NOT LIKE 'L1e:%'
 THEN RAISE EXCEPTION 'l1g: the rules ladder must be marked L1g and the rules-off ladder stay L1e'; END IF;
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_function_privilege(r,'public.resolve_context_attribution(public.business_events,boolean,boolean)','EXECUTE')
  THEN RAISE EXCEPTION 'l1g: % can call the private rules ladder',r; END IF;
 END LOOP;
 IF NOT has_function_privilege('service_role','public.resolve_context_attribution(public.business_events)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.context_attribution_preview(uuid,boolean)','EXECUTE')
 THEN RAISE EXCEPTION 'l1g: the service role lost the ladder entry or the preview'; END IF;
 IF (SELECT count(*) FROM public.feature_flags WHERE flag_name='context_unlinked_rules_v1' AND NOT enabled)<>1
 THEN RAISE EXCEPTION 'l1g: the rules flag must stay off'; END IF;
END $$;

-- Re-apply is a no-op.
CREATE TEMP TABLE l1g_before AS SELECT md5(p.prosrc) AS md5, obj_description(p.oid,'pg_proc') AS note
 FROM pg_proc p WHERE p.oid='public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure;
\ir ../../../migrations/20261006035000_context_ladder_held_live_job.sql
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM l1g_before b, pg_proc p WHERE p.oid='public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure
   AND (md5(p.prosrc) IS DISTINCT FROM b.md5 OR obj_description(p.oid,'pg_proc') IS DISTINCT FROM b.note))
 THEN RAISE EXCEPTION 'l1g: re-apply changed the body or comment'; END IF;
END $$;
DROP TABLE l1g_before;
