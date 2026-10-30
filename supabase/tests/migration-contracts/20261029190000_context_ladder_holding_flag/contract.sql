-- Ladder holding flag contract (20261029190000, TP-04). Every fixture write
-- is rolled back. Ids, job numbers, contacts, claims, sites and text are
-- synthetic.
--
-- The rule: a job is holding exactly when Job Profit says so,
-- lower(coalesce(metadata->>'do_not_schedule','')) = 'true'. So the word true
-- in any case (JSON true, "true", "TRUE", "True") is holding, and 1, "1",
-- false, "yes" and no flag at all are not. Under the old ladder spelling,
-- NOT IN ('true','1'), a job flagged 1 or "1" was never a candidate and one
-- flagged "TRUE" or "True" was.
--   A. Each of the nine replaced bodies reads one job per flag spelling and
--      keeps exactly the jobs that are not holding: the two contact
--      timelines (and the candidate sets read through them), the reference
--      lookup, a job that can be a customer's, quote link tokens, builder
--      claims, the internal-text job, the writer job.
--   B. The live ladder (rules on, through the real insert trigger) places a
--      customer text, a row naming its own job (step 1b), a reference and a
--      site address on a job that is not holding, and on no holding job.
--   C. Structure: each body is its pre-image with only the predicate
--      replaced, no replaced body keeps the old spelling, comments and
--      grants are as they were, the frozen rules-off ladder is untouched,
--      and a re-apply is a no-op.
\set ON_ERROR_STOP 1

CREATE FUNCTION pg_temp.tp04_flag(p_on boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 UPDATE public.feature_flags SET enabled=p_on,updated_at=clock_timestamp() WHERE flag_name='context_unlinked_rules_v1';
 IF public.context_unlinked_rules_enabled() IS DISTINCT FROM p_on THEN RAISE EXCEPTION 'tp04 fixture: rules flag not %',p_on; END IF;
END $$;

-- One job per spelling of the flag. holding is the canonical answer.
CREATE FUNCTION pg_temp.tp04_fixture() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 CREATE TEMP TABLE tp04_jobs(k text PRIMARY KEY, n int, flag jsonb, holding boolean, id uuid, job_number text, contact text,
  street text, claim text, token text) ON COMMIT DROP;
 INSERT INTO tp04_jobs(k,n,flag,holding) VALUES
  ('no flag',1,NULL,false),
  ('JSON 1',2,'1',false),
  ('"1"',3,'"1"',false),
  ('JSON false',4,'false',false),
  ('"yes"',5,'"yes"',false),
  ('JSON true',6,'true',true),
  ('"true"',7,'"true"',true),
  ('"TRUE"',8,'"TRUE"',true),
  ('"True"',9,'"True"',true);
 UPDATE tp04_jobs SET id=gen_random_uuid(), job_number='SWF-99410'||n, contact='tp04-contact-'||n,
  street=(ARRAY['Alder','Birch','Cedar','Dogwood','Elmwood','Fernhill','Gumtree','Hazel','Ivory'])[n],
  claim='MLB-7710'||n, token=gen_random_uuid()::text;
 INSERT INTO public.jobs(id,org_id,job_number,status,type,ghl_contact_id,site_address,created_at,metadata)
 SELECT id,'00000000-0000-0000-0000-000000000001',job_number,'scheduled','fencing',contact,
  n||' '||street||' Street, Yokine WA 6060','2026-09-01Z',
  jsonb_build_object('mlb_ref',claim)||CASE WHEN flag IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('do_not_schedule',flag) END
 FROM tp04_jobs;
 INSERT INTO public.job_documents(job_id,type,file_name,share_token) SELECT id,'quote','quote-'||n||'.pdf',token FROM tp04_jobs;
END $$;

-- Which spellings a check got wrong: kept a holding job, or dropped one that
-- is not holding.
CREATE FUNCTION pg_temp.tp04_expect(p_check text,p_kept uuid[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE wrong text;
BEGIN
 SELECT string_agg(k||CASE WHEN holding THEN ' (holding, kept)' ELSE ' (not holding, dropped)' END,', ' ORDER BY n) INTO wrong
 FROM tp04_jobs WHERE (id=ANY(coalesce(p_kept,'{}'))) IS DISTINCT FROM (NOT holding);
 IF wrong IS NOT NULL THEN RAISE EXCEPTION 'tp04 %: the holding flag is read wrong for %',p_check,wrong; END IF;
END $$;

CREATE FUNCTION pg_temp.tp04_cases() RETURNS void LANGUAGE plpgsql AS $$
DECLARE x record; kept uuid[]; e public.business_events; at constant timestamptz:='2026-09-20 02:00Z';
BEGIN
 PERFORM pg_temp.tp04_fixture();

 ------------------------------------------------------------ A. each body
 -- P1a's two-argument timeline: P1b's reconsideration and both Luna
 -- overloads read their candidates through it.
 SELECT array_agg(t.job_id) INTO kept FROM tp04_jobs j, public.context_contact_job_timeline(j.contact,at) t;
 PERFORM pg_temp.tp04_expect('P1a timeline (two-argument)',kept);
 SELECT array_agg(c.job_id) INTO kept FROM tp04_jobs j, public.context_contact_jobs_at(j.contact,at) c;
 PERFORM pg_temp.tp04_expect('P1a candidate set (two-argument)',kept);
 -- P4's four-argument timeline: the rules-on ladder's candidates.
 SELECT array_agg(t.job_id) INTO kept FROM tp04_jobs j, public.context_contact_job_timeline(j.contact,at,NULL,NULL) t;
 PERFORM pg_temp.tp04_expect('P4 timeline (four-argument)',kept);
 SELECT array_agg(c.job_id) INTO kept FROM tp04_jobs j, public.context_contact_jobs_at(j.contact,at,NULL,NULL) c;
 PERFORM pg_temp.tp04_expect('P4 candidate set (four-argument)',kept);
 -- B0's reference lookup.
 SELECT array_agg(r.job_id) INTO kept FROM public.context_ref_jobs((SELECT array_agg(upper(job_number)) FROM tp04_jobs)) r;
 PERFORM pg_temp.tp04_expect('B0 reference lookup',kept);
 -- Stage 1: a job that can be a customer's, quote link tokens, builder claims.
 SELECT array_agg(id) INTO kept FROM tp04_jobs WHERE public.context_job_real(id);
 PERFORM pg_temp.tp04_expect('stage 1 customer job',kept);
 SELECT public.context_link_ref_jobs(string_agg('https://example.invalid/quote?token='||token,' ')) INTO kept FROM tp04_jobs;
 PERFORM pg_temp.tp04_expect('stage 1 quote link',kept);
 kept:='{}';
 FOR x IN SELECT * FROM tp04_jobs LOOP
  kept:=kept||public.context_builder_ref_jobs('Work order '||x.claim,'[]'::jsonb);
 END LOOP;
 PERFORM pg_temp.tp04_expect('stage 1 builder claim',kept);
 -- L1d's internal-text job and L1e's writer job.
 kept:='{}';
 FOR x IN SELECT * FROM tp04_jobs LOOP
  e:=NULL; e.payload:='{}'; e.metadata:=jsonb_build_object('about_job_id',x.id);
  kept:=kept||ARRAY(SELECT i.job_id FROM public.context_internal_about_job(e) i);
 END LOOP;
 PERFORM pg_temp.tp04_expect('L1d internal-text job',kept);
 kept:='{}';
 FOR x IN SELECT * FROM tp04_jobs LOOP
  e:=NULL; e.job_id:=x.id; e.payload:='{}'; e.metadata:=jsonb_build_object('written_as','service_role');
  kept:=kept||public.context_event_writer_job(e);
 END LOOP;
 PERFORM pg_temp.tp04_expect('L1e writer job',array_remove(kept,NULL));

 ------------------------------------------------------------ B. the live ladder, rules on
 PERFORM pg_temp.tp04_flag(true);
 -- A customer text from the job's own contact: single_open on a job that is
 -- not holding; a holding job is no candidate, so nothing places.
 kept:='{}';
 FOR x IN SELECT * FROM tp04_jobs ORDER BY n LOOP
  INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,contact_id,payload)
  VALUES('client.sms_in','ghl-webhook-receiver','sms','inbound',at,at,x.contact,'{"body":"Is Thursday still ok?"}') RETURNING * INTO e;
  IF e.job_id IS NOT NULL AND e.job_id<>x.id THEN RAISE EXCEPTION 'tp04 ladder text (%): placed on another job, % %',x.k,e.attribution_status,e.job_id; END IF;
  IF e.job_id=x.id AND e.attribution_status<>'single_open' THEN RAISE EXCEPTION 'tp04 ladder text (%): expected single_open, got %',x.k,e.attribution_status; END IF;
  kept:=kept||e.job_id;
 END LOOP;
 PERFORM pg_temp.tp04_expect('ladder customer text',array_remove(kept,NULL));
 -- Step 1b: a row naming its own job (payload.job_id) is placed there only
 -- when the job is not holding; a holding job leaves it unbindable.
 kept:='{}';
 FOR x IN SELECT * FROM tp04_jobs ORDER BY n LOOP
  INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,payload)
  VALUES('job.note_added','app/office','note','internal',at,at,jsonb_build_object('job_id',x.id::text,'body','Measured the run')) RETURNING * INTO e;
  IF e.job_id IS NOT NULL AND (e.job_id<>x.id OR e.metadata->>'placement_rule' IS DISTINCT FROM 'payload_job')
  THEN RAISE EXCEPTION 'tp04 ladder payload job (%): got % % %',x.k,e.attribution_status,e.job_id,e.metadata->>'placement_rule'; END IF;
  IF e.job_id IS NULL AND e.metadata->>'placement_rule' IS DISTINCT FROM 'payload_job_unbindable'
  THEN RAISE EXCEPTION 'tp04 ladder payload job (%): an unplaced row must be payload_job_unbindable, got %',x.k,e.metadata->>'placement_rule'; END IF;
  kept:=kept||e.job_id;
 END LOOP;
 PERFORM pg_temp.tp04_expect('ladder payload job',array_remove(kept,NULL));
 -- A job number in an email from a sender we do not know.
 kept:='{}';
 FOR x IN SELECT * FROM tp04_jobs ORDER BY n LOOP
  INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,payload)
  VALUES('client.email_in','monitor-inbox','email','inbound',at,at,
   jsonb_build_object('from','office@supplier-tp04.example','subject','Delivery for '||x.job_number,'body','Booked for Monday.')) RETURNING * INTO e;
  IF e.job_id IS NOT NULL AND e.job_id<>x.id THEN RAISE EXCEPTION 'tp04 ladder reference (%): placed on another job %',x.k,e.job_id; END IF;
  kept:=kept||e.job_id;
 END LOOP;
 PERFORM pg_temp.tp04_expect('ladder reference',array_remove(kept,NULL));
 -- A council email naming the site, from no contact (step 6).
 kept:='{}';
 FOR x IN SELECT * FROM tp04_jobs ORDER BY n LOOP
  INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,payload)
  VALUES('client.email_in','monitor-inbox','email','inbound',at,at,
   jsonb_build_object('from','planning@council-tp04.example','subject','RFI - Building permit - '||x.n||' '||x.street||' Street YOKINE','body','Further information is required.')) RETURNING * INTO e;
  IF e.job_id IS NOT NULL AND (e.job_id<>x.id OR e.metadata->>'placement_rule' NOT LIKE 'site_address%')
  THEN RAISE EXCEPTION 'tp04 ladder site (%): got % % %',x.k,e.attribution_status,e.job_id,e.metadata->>'placement_rule'; END IF;
  kept:=kept||e.job_id;
 END LOOP;
 PERFORM pg_temp.tp04_expect('ladder site address',array_remove(kept,NULL));
 PERFORM pg_temp.tp04_flag(false);
END $$;

BEGIN;
SELECT pg_temp.tp04_cases();
ROLLBACK;

-- C. Structure.
DO $$
DECLARE x record; problems text[]:='{}'; src text; r text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_contact_job_timeline(text,timestamptz)','2bc8e76f14fda242eb6e4d414e93fefa','88d0aa3f8bdbb2800d66954b5655f0dd','Every job of a GHL contact %',false),
  ('public.context_contact_job_timeline(text,timestamptz,text,text)','f98da204718a4d5ac6395761a963ced4','be5e8d7df251fb3baf2d1a47641d93eb','P4:%',false),
  ('public.context_ref_jobs(text[])','f21ce8cf72292e016daf18d1ee5e9a8c','14931b7986111458def3808cf85bbb57','B0:%',true),
  ('public.context_internal_about_job(public.business_events)','aa53618f6c82998a821b8f7439c75e60','550176dbcdf545efa3c4703e160aec96','L1d:%',false),
  ('public.context_event_writer_job(public.business_events)','cd36b092818e7607d114d1b3011b3bfd','9d29d9087ebb8765cc994174a960b6d4','L1e:%',false),
  ('public.context_job_real(uuid)','9e56ab3916a2522c7fcef3019849e535','7e2fdda96e02d11a45ef8188969c9a5a','Unplaced stage 1 (20261014170000)%',true),
  ('public.context_link_ref_jobs(text)','7c7a9c1330656d02b88caa00a619e5ef','840a52b5a5a4805d5524a57f70c63572','Unplaced stage 1 (20261014170000)%',true),
  ('public.context_builder_ref_jobs(text,jsonb)','9ba7c6a2f309830807fae6cfb4451838','e4d864aa2b41862ea7fcf8e6b49260e7','Unplaced stage 1 (20261014170000)%',true),
  ('public.resolve_context_attribution(public.business_events,boolean,boolean)','58fcf93d4c82604822d4ca4b70cc4680','2ccef791fca954bfe1fcbb4e0de5f8a2','L1g plus unplaced stage 1 (20261014170000)%',false)
 ) AS t(sig,old_md5,new_md5,note,service_role) LOOP
  SELECT p.prosrc INTO src FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF md5(src) IS DISTINCT FROM x.new_md5 THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(md5(src),'<missing>')); CONTINUE; END IF;
  -- Undoing the predicate gives back the pre-image byte for byte.
  IF md5(regexp_replace(src,$p$lower\(coalesce\(([a-z]+)\.metadata->>'do_not_schedule',''\)\) <> 'true'$p$,
     $p$coalesce(\1.metadata->>'do_not_schedule','') NOT IN ('true','1')$p$,'g'))<>x.old_md5
  THEN problems:=problems||format('%s is not its pre-image with only the holding predicate replaced',x.sig); END IF;
  IF src ~ $p$do_not_schedule',''\) NOT IN \('true','1'\)$p$ THEN problems:=problems||format('%s keeps the old holding spelling',x.sig); END IF;
  IF coalesce(obj_description(to_regprocedure(x.sig),'pg_proc'),'') NOT LIKE x.note THEN problems:=problems||format('%s lost its comment',x.sig); END IF;
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF has_function_privilege(r,x.sig,'EXECUTE') THEN problems:=problems||format('%s can call %s',r,x.sig); END IF;
  END LOOP;
  IF has_function_privilege('service_role',x.sig,'EXECUTE') IS DISTINCT FROM x.service_role
  THEN problems:=problems||format('the service role grant on %s changed',x.sig); END IF;
 END LOOP;
 -- The frozen rules-off ladder (P1a's copy) and the entry are untouched.
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ladder_p1a(public.business_events,boolean)'::regprocedure)<>'ce620833c851196a00eca328d9b7426a'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events)'::regprocedure)<>'32365101d23dde1695707a0bddff640b'
 THEN problems:=problems||'the frozen rules-off ladder or the entry changed'::text; END IF;
 IF (SELECT count(*) FROM public.feature_flags WHERE flag_name='context_unlinked_rules_v1' AND NOT enabled)<>1
 THEN problems:=problems||'the rules flag must stay off'::text; END IF;
 IF cardinality(problems)>0 THEN RAISE EXCEPTION 'tp04 structure: %',array_to_string(problems,'; '); END IF;
END $$;

-- Re-apply is a no-op.
CREATE TEMP TABLE tp04_before AS SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS md5, obj_description(p.oid,'pg_proc') AS note,
 p.proacl::text AS acl
 FROM pg_proc p WHERE p.oid IN ('public.context_contact_job_timeline(text,timestamptz)'::regprocedure,
  'public.context_contact_job_timeline(text,timestamptz,text,text)'::regprocedure,'public.context_ref_jobs(text[])'::regprocedure,
  'public.context_internal_about_job(public.business_events)'::regprocedure,'public.context_event_writer_job(public.business_events)'::regprocedure,
  'public.context_job_real(uuid)'::regprocedure,'public.context_link_ref_jobs(text)'::regprocedure,
  'public.context_builder_ref_jobs(text,jsonb)'::regprocedure,'public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure);
\ir ../../../migrations/20261029190000_context_ladder_holding_flag.sql
DO $$
BEGIN
 IF (SELECT count(*) FROM tp04_before)<>9 THEN RAISE EXCEPTION 'tp04: expected 9 functions, got %',(SELECT count(*) FROM tp04_before); END IF;
 IF EXISTS(SELECT 1 FROM tp04_before b LEFT JOIN pg_proc p ON p.oid=b.sig::regprocedure
   WHERE md5(p.prosrc) IS DISTINCT FROM b.md5 OR obj_description(p.oid,'pg_proc') IS DISTINCT FROM b.note OR p.proacl::text IS DISTINCT FROM b.acl)
 THEN RAISE EXCEPTION 'tp04: re-apply changed a body, comment or grant'; END IF;
END $$;
DROP TABLE tp04_before;
