-- Ladder step 1b contract (20261003100000). Every fixture write is rolled
-- back. Ids, job numbers, contacts and text are synthetic.
--
-- Proves, with the rules flag off (as shipped) and on:
--   A. A row whose payload.job_id names a job that is not holding lands on
--      that job (direct, step 1, payload_job), even when a single-open job or
--      several Luna candidates exist for its contact; the revision store
--      accepts it there.
--   B. A payload job that is missing, holding, in another spelling or not a
--      uuid rests the row in the bucket (payload_job_unbindable), never on
--      the contact's job. A JSON null payload job changes nothing.
--   C. Custody beats the payload: a writer's job with an allowed method stays.
--   D. context_reconsider_contact (a new job for the contact) and Luna's write
--      boundary never move a payload-bound row, while they still move a
--      contact-rule row.
--   E. Structure: both bodies are P4's plus exactly step 1b, private, marked
--      L1b so P4's re-apply refuses, and a re-apply of this migration is a
--      no-op.
\set ON_ERROR_STOP 1

CREATE FUNCTION pg_temp.pj_job(p_number text,p_contact text,p_meta jsonb DEFAULT '{}'::jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,metadata,created_at)
  VALUES(j,'00000000-0000-0000-0000-000000000001','scheduled','fencing',p_number,p_contact,p_meta,now()-interval '60 days');
 RETURN j;
END $$;

-- A worded inbound text from p_contact through the real insert trigger, with
-- no writer job; the ladder decides it.
CREATE FUNCTION pg_temp.pj_ev(p_contact text,p_payload jsonb) RETURNS public.business_events LANGUAGE plpgsql AS $$
DECLARE e public.business_events;
BEGIN
 INSERT INTO public.business_events(contact_id,direction,event_type,source,payload,occurred_at,event_at)
  VALUES(p_contact,'inbound','client.sms_in','payload_job_contract',p_payload||'{"body":"Payload job fixture text"}',
   now()-interval '1 day',now()-interval '1 day')
  RETURNING * INTO e;
 RETURN e;
END $$;

-- What the revision store says about one row as the whole batch for p_job.
-- The store's work is always undone (the probe raises after a success).
CREATE FUNCTION pg_temp.pj_b3(p_job uuid,p_event uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE run uuid:=gen_random_uuid(); lease uuid:=gen_random_uuid(); events jsonb; res jsonb; msg text;
BEGIN
 SELECT jsonb_agg(to_jsonb(e)) INTO events FROM public.business_events e WHERE e.id=p_event;
 BEGIN
  INSERT INTO public.context_extraction_runs(id,job_id,run_date,phase,status,run_seq,lease_token,lease_expires_at)
   VALUES(run,p_job,(now() AT TIME ZONE 'Australia/Perth')::date,'extraction','running',
    coalesce((SELECT max(run_seq) FROM public.context_extraction_runs WHERE job_id=p_job AND run_date=(now() AT TIME ZONE 'Australia/Perth')::date),0)+1,
    lease,now()+interval '30 minutes');
  res:=public.persist_luna_context_revision(run,lease,p_job,events,'[]','[]','[]','luna_v2',1);
  RAISE EXCEPTION 'pj_probe:%',res->>'outcome';
 EXCEPTION WHEN OTHERS THEN msg:=SQLERRM;
 END;
 RETURN CASE WHEN msg='pj_probe:inserted' THEN 'accepted' ELSE msg END;
END $$;

-- A to D, once for the given flag state. Raises on the first broken promise.
CREATE FUNCTION pg_temp.pj_cases(p_rules_on boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE lbl text:=CASE WHEN p_rules_on THEN 'rules on' ELSE 'rules off' END;
 a1 uuid; a2 uuid; a3 uuid; b uuid; h uuid; n uuid; e public.business_events; s public.business_events;
 ctl1 public.business_events; ctl2 public.business_events; won1 public.business_events; won2 public.business_events;
 bad public.business_events; v text; p jsonb; before jsonb; luna_err text;
BEGIN
 UPDATE public.feature_flags SET enabled=p_rules_on,updated_at=clock_timestamp() WHERE flag_name='context_unlinked_rules_v1';
 IF public.context_unlinked_rules_enabled() IS DISTINCT FROM p_rules_on THEN RAISE EXCEPTION 'l1b fixture: flag not %',lbl; END IF;
 -- pj-c1 has one live job, pj-c2 two (Luna's case); B is the payload's own
 -- job (another customer's), H is holding.
 a1:=pg_temp.pj_job('PJ-A1','pj-c1');
 a2:=pg_temp.pj_job('PJ-A2','pj-c2'); a3:=pg_temp.pj_job('PJ-A3','pj-c2');
 b:=pg_temp.pj_job('PJ-B','pj-other');
 h:=pg_temp.pj_job('PJ-H','pj-other','{"do_not_schedule":true}');

 -- A. Controls: without a payload job the contact rules decide.
 ctl1:=pg_temp.pj_ev('pj-c1','{}');
 IF ctl1.job_id IS DISTINCT FROM a1 OR ctl1.attribution_status<>'single_open'
 THEN RAISE EXCEPTION 'l1b %: control must be single_open on PJ-A1, got % %',lbl,ctl1.attribution_status,ctl1.job_id; END IF;
 ctl2:=pg_temp.pj_ev('pj-c2','{}');
 IF ctl2.job_id IS NOT NULL OR ctl2.attribution_status<>'pending_luna' OR NOT (a2=ANY(ctl2.candidate_job_ids) AND a3=ANY(ctl2.candidate_job_ids))
 THEN RAISE EXCEPTION 'l1b %: control must be pending_luna with PJ-A2 and PJ-A3, got % %',lbl,ctl2.attribution_status,ctl2.candidate_job_ids; END IF;

 -- A. A bindable payload job wins over single_open and over Luna's candidates.
 won1:=pg_temp.pj_ev('pj-c1',jsonb_build_object('job_id',b::text));
 won2:=pg_temp.pj_ev('pj-c2',jsonb_build_object('job_id',b::text));
 FOREACH e IN ARRAY ARRAY[won1,won2] LOOP
  IF e.job_id IS DISTINCT FROM b OR e.attribution_status<>'direct' OR e.attribution_step<>1 OR e.attribution_confidence<>1
   OR e.match_status<>'matched' OR e.match_method<>'direct_job_id' OR e.candidate_job_ids IS NOT NULL
   OR e.metadata->>'placement_rule' IS DISTINCT FROM 'payload_job' OR e.metadata ? 'bucket_reason'
  THEN RAISE EXCEPTION 'l1b %: a bindable payload job must win over single_open and Luna, got % % % %',lbl,e.attribution_status,e.job_id,e.match_method,e.metadata; END IF;
  -- The revision store and the batch admission accept it on its own job.
  v:=pg_temp.pj_b3(b,e.id);
  IF v<>'accepted' OR NOT public.context_event_source_admissible(e)
  THEN RAISE EXCEPTION 'l1b %: the revision store must accept a payload-placed row on its job, got %',lbl,v; END IF;
 END LOOP;
 -- The preview of the stored row keeps it there (rules off reads the stored
 -- direct placement as custody; rules on re-derives step 1b).
 p:=public.context_attribution_preview(won1.id,p_rules_on);
 IF p->'decided'->>'job_id' IS DISTINCT FROM b::text OR p->'decided'->>'attribution_status'<>'direct'
  OR p->'decided'->>'match_method'<>'direct_job_id'
 THEN RAISE EXCEPTION 'l1b %: preview must place on the payload job, got %',lbl,p; END IF;
 -- A re-decision keeps it there.
 SELECT * INTO e FROM public.business_events WHERE id=won1.id;
 s:=public.resolve_context_attribution(e);
 IF s.job_id IS DISTINCT FROM b OR s.attribution_status<>'direct'
 THEN RAISE EXCEPTION 'l1b %: a re-decision moved a payload-placed row, got % %',lbl,s.attribution_status,s.job_id; END IF;

 -- B. An unbindable payload job: the bucket, never the contact's job.
 FOREACH v IN ARRAY ARRAY[gen_random_uuid()::text,h::text,upper(b::text),'PJ-B',''] LOOP
  bad:=pg_temp.pj_ev('pj-c1',jsonb_build_object('job_id',v));
  IF bad.job_id IS NOT NULL OR bad.attribution_status<>'admin_bucket' OR bad.attribution_step<>6
   OR bad.metadata->>'bucket_reason' IS DISTINCT FROM 'payload_job_unbindable' OR bad.metadata->>'placement_rule' IS DISTINCT FROM 'payload_job_unbindable'
   OR bad.candidate_job_ids IS NOT NULL OR bad.match_method<>'none' OR bad.attribution_confidence IS NOT NULL
  THEN RAISE EXCEPTION 'l1b %: an unbindable payload job (%) must bucket the row, got % % %',lbl,v,bad.attribution_status,bad.job_id,bad.metadata; END IF;
  p:=public.context_attribution_preview(bad.id,p_rules_on);
  IF p->'decided'->>'bucket_reason' IS DISTINCT FROM 'payload_job_unbindable' OR p->'decided'->>'job_id' IS NOT NULL
  THEN RAISE EXCEPTION 'l1b %: preview must bucket an unbindable payload job, got %',lbl,p; END IF;
 END LOOP;
 -- A JSON null payload job is no claim: the contact rules decide.
 e:=pg_temp.pj_ev('pj-c1','{"job_id":null}');
 IF e.job_id IS DISTINCT FROM a1 OR e.attribution_status<>'single_open'
 THEN RAISE EXCEPTION 'l1b %: a JSON null payload job must leave the contact rules alone, got % %',lbl,e.attribution_status,e.job_id; END IF;

 -- C. Custody beats the payload.
 INSERT INTO public.business_events(job_id,match_method,contact_id,direction,event_type,source,payload,occurred_at,event_at)
  VALUES(a1,'direct_job_id','pj-c1','inbound','client.sms_in','payload_job_contract',
   jsonb_build_object('job_id',b::text,'body','Custody fixture text'),now()-interval '1 day',now()-interval '1 day')
  RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM a1 OR e.attribution_status<>'direct' OR e.match_method<>'direct_job_id'
 THEN RAISE EXCEPTION 'l1b %: a custody placement must stay on the writer''s job, got % %',lbl,e.attribution_status,e.job_id; END IF;

 -- D. Luna's write boundary refuses a payload-bound row and leaves it.
 SELECT to_jsonb(x) INTO before FROM public.business_events x WHERE x.id=won2.id;
 BEGIN
  PERFORM public.attribute_context_event_with_luna(won2.id,a2,0.9,'job');
  luna_err:=NULL;
 EXCEPTION WHEN OTHERS THEN luna_err:=SQLERRM;
 END;
 IF luna_err IS DISTINCT FROM 'event is not pending Luna' THEN RAISE EXCEPTION 'l1b %: Luna must refuse a payload-bound row, got %',lbl,coalesce(luna_err,'a placement'); END IF;
 BEGIN
  PERFORM public.attribute_context_event_with_luna(won2.id,a2,0.9);
  luna_err:=NULL;
 EXCEPTION WHEN OTHERS THEN luna_err:=SQLERRM;
 END;
 IF luna_err IS DISTINCT FROM 'event is not pending Luna' THEN RAISE EXCEPTION 'l1b %: Luna (three arguments) must refuse a payload-bound row, got %',lbl,coalesce(luna_err,'a placement'); END IF;
 IF (SELECT to_jsonb(x) FROM public.business_events x WHERE x.id=won2.id) IS DISTINCT FROM before
 THEN RAISE EXCEPTION 'l1b %: Luna changed a payload-bound row',lbl; END IF;

 -- D. A new job for pj-c1 reconsiders the contact's messages (the job insert
 -- trigger, then the same call again). The contact-rule control moves; the
 -- payload-bound and the unbindable rows do not.
 n:=gen_random_uuid();
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at)
  VALUES(n,'00000000-0000-0000-0000-000000000001','scheduled','fencing','PJ-N','pj-c1',now());
 PERFORM public.context_reconsider_contact('pj-c1',now()-interval '30 days','job_created',n);
 SELECT * INTO e FROM public.business_events WHERE id=ctl1.id;
 IF e.job_id IS NOT DISTINCT FROM a1 AND e.attribution_status='single_open'
 THEN RAISE EXCEPTION 'l1b %: fixture: reconsideration did not touch the contact-rule control',lbl; END IF;
 SELECT * INTO e FROM public.business_events WHERE id=won1.id;
 IF e.job_id IS DISTINCT FROM b OR e.attribution_status<>'direct' OR e.metadata ? 'placement_reconsidered'
 THEN RAISE EXCEPTION 'l1b %: reconsideration moved a payload-bound row, got % %',lbl,e.attribution_status,e.job_id; END IF;
 SELECT * INTO e FROM public.business_events WHERE id=bad.id;
 IF e.job_id IS NOT NULL OR e.attribution_status<>'admin_bucket' OR e.metadata->>'bucket_reason' IS DISTINCT FROM 'payload_job_unbindable'
 THEN RAISE EXCEPTION 'l1b %: reconsideration moved an unbindable payload row, got % %',lbl,e.attribution_status,e.job_id; END IF;
END $$;

BEGIN;
SELECT pg_temp.pj_cases(false);
ROLLBACK;
BEGIN;
SELECT pg_temp.pj_cases(true);
ROLLBACK;

-- E. Structure. A registered successor (L1c 20261004200000, then L1d
-- 20261005090000, then L1e 20261005170000) proves in its own contract that its bodies are exactly the
-- previous ones plus or with its rules; while one is live the byte checks
-- below are its, not these.
SELECT coalesce(obj_description('public.context_ladder_p1a(public.business_events,boolean)'::regprocedure,'pg_proc'),'') SIMILAR TO 'L1(c|d|e):%' AS l1c_live \gset
DO $$
DECLARE f text; r text;
BEGIN
 IF coalesce(obj_description('public.context_ladder_p1a(public.business_events,boolean)'::regprocedure,'pg_proc'),'') NOT SIMILAR TO 'L1(c|d|e):%' AND ((SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ladder_p1a(public.business_events,boolean)'::regprocedure)<>'6a45c9ea9a68c8c5899fba45b44e18b5'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure)<>'a0205f1a17ae9866ca4c8e57ff2746e4')
 THEN RAISE EXCEPTION 'l1b: a ladder body is not this migration''s'; END IF;
 -- Undoing step 1b gives back P4's two bodies byte for byte.
 IF coalesce(obj_description('public.context_ladder_p1a(public.business_events,boolean)'::regprocedure,'pg_proc'),'') NOT SIMILAR TO 'L1(c|d|e):%' AND md5(replace((SELECT prosrc FROM pg_proc WHERE oid='public.context_ladder_p1a(public.business_events,boolean)'::regprocedure),
   $b$ -- 1b. The source's own job (20261003100000), as in the rules-on ladder: a
 -- payload.job_id that is the exact id text of a job that is not holding is
 -- the candidate (direct, step 1); one that names no such job rests the row
 -- in the bucket (payload_job_unbindable), never on another job.
 IF candidate IS NULL AND e.payload#>>'{job_id}' IS NOT NULL THEN
  IF e.payload#>>'{job_id}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
   SELECT j.id INTO candidate FROM public.jobs j WHERE j.id=(e.payload#>>'{job_id}')::uuid
    AND coalesce(j.metadata->>'do_not_schedule','') NOT IN ('true','1');
  END IF;
  IF candidate IS NULL THEN
   e.job_id:=NULL;
   e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('bucket_reason','payload_job_unbindable','placement_rule','payload_job_unbindable');
   RETURN e;
  END IF;
  e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('placement_rule','payload_job');
 END IF;
$b$,''))<>'9ce621de1f295757e9ed83abdc2f3765'
 THEN RAISE EXCEPTION 'l1b: context_ladder_p1a is not P4''s body plus step 1b'; END IF;
 IF coalesce(obj_description('public.context_ladder_p1a(public.business_events,boolean)'::regprocedure,'pg_proc'),'') NOT SIMILAR TO 'L1(c|d|e):%' AND md5(replace(replace((SELECT prosrc FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure),
   $b$   -- 1b. The source's own job (20261003100000). A payload.job_id that is the
   -- exact id text of a job that is not holding places the row there (rule
   -- payload_job, a step-1 direct placement), whatever a contact rule would
   -- pick. One that names no such job (missing, holding, another spelling)
   -- rests the row in the bucket with bucket_reason payload_job_unbindable,
   -- never on another job: the revision store refuses a row whose payload
   -- names a job other than the one it sits on.
   IF cand IS NULL AND e.payload#>>'{job_id}' IS NOT NULL THEN
    IF e.payload#>>'{job_id}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
     SELECT j.id INTO cand FROM public.jobs j WHERE j.id=(e.payload#>>'{job_id}')::uuid
      AND coalesce(j.metadata->>'do_not_schedule','') NOT IN ('true','1');
    END IF;
    IF cand IS NULL THEN
     e.metadata:=e.metadata||jsonb_build_object('bucket_reason','payload_job_unbindable','placement_rule','payload_job_unbindable');
     EXIT rules;
    END IF;
    e.attribution_status:='direct'; e.attribution_step:=1; rule:='payload_job';
   END IF;

$b$,''),$b$   e.match_method:=CASE WHEN custody THEN source_method WHEN rule='payload_job' THEN 'direct_job_id' WHEN rule='direct_ref' THEN 'ladder_ref'
$b$,$b$   e.match_method:=CASE WHEN custody THEN source_method WHEN rule='direct_ref' THEN 'ladder_ref'
$b$))<>'e04d9e81649364b8e9acc38f14833ba2'
 THEN RAISE EXCEPTION 'l1b: the rules ladder is not P4''s body plus step 1b'; END IF;
 -- The entry and the insert trigger are P4's and untouched.
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events)'::regprocedure)<>'32365101d23dde1695707a0bddff640b'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.attribute_business_event()'::regprocedure)<>'d0036a1bc36f4b2a779f4a8b192cd687'
 THEN RAISE EXCEPTION 'l1b: the ladder entry or insert trigger changed'; END IF;
 -- Marked L1b, not P4: P4's guard refuses to re-apply over them.
 FOREACH f IN ARRAY ARRAY['public.context_ladder_p1a(public.business_events,boolean)','public.resolve_context_attribution(public.business_events,boolean,boolean)'] LOOP
  IF coalesce(obj_description(f::regprocedure,'pg_proc'),'') NOT LIKE 'L1b:%' AND coalesce(obj_description(f::regprocedure,'pg_proc'),'') NOT SIMILAR TO 'L1(c|d|e|f|g):%'
  THEN RAISE EXCEPTION 'l1b: % is not marked L1b (or a successor, L1c, L1d, L1e, L1f or L1g)',f; END IF;
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_function_privilege(r,f,'EXECUTE') THEN RAISE EXCEPTION 'l1b: % can call private %',r,f; END IF;
  END LOOP;
 END LOOP;
 IF NOT has_function_privilege('service_role','public.resolve_context_attribution(public.business_events)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.context_attribution_preview(uuid,boolean)','EXECUTE')
 THEN RAISE EXCEPTION 'l1b: the service role lost the ladder entry or the preview'; END IF;
 IF (SELECT count(*) FROM public.feature_flags WHERE flag_name='context_unlinked_rules_v1' AND NOT enabled)<>1
 THEN RAISE EXCEPTION 'l1b: the rules flag must stay off'; END IF;
END $$;

-- Re-apply is a no-op. It runs only while L1b's ladder is live; a registered
-- successor (L1c 20261004200000, then L1d, then L1e) marks its bodies, so L1b's guard refuses a
-- re-apply over it instead of removing its rules.
\if :l1c_live
\else
CREATE TEMP TABLE l1b_before AS SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS md5, obj_description(p.oid,'pg_proc') AS note
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('context_ladder_p1a','resolve_context_attribution');
\ir ../../../migrations/20261003100000_context_ladder_payload_job.sql
DO $$
BEGIN
 IF (SELECT count(*) FROM l1b_before)<>3 THEN RAISE EXCEPTION 'l1b: expected 3 ladder functions, got %',(SELECT count(*) FROM l1b_before); END IF;
 IF EXISTS(SELECT 1 FROM l1b_before b LEFT JOIN pg_proc p ON p.oid=b.sig::regprocedure
   WHERE md5(p.prosrc) IS DISTINCT FROM b.md5 OR obj_description(p.oid,'pg_proc') IS DISTINCT FROM b.note)
 THEN RAISE EXCEPTION 'l1b: re-apply changed a body or comment'; END IF;
END $$;
DROP TABLE l1b_before;
\endif
