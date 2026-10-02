-- Payload-job repair contract. Every fixture write is rolled back. Ids, job
-- numbers and text are synthetic.

CREATE FUNCTION pg_temp.pr_job(p_number text,p_meta jsonb DEFAULT '{}'::jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,metadata,created_at)
  VALUES(j,'00000000-0000-0000-0000-000000000001','scheduled','fencing',p_number,p_meta,now()-interval '60 days');
 RETURN j;
END $$;

-- A worded row placed on p_job with p_status (custody insert through the real
-- trigger, then the status a contact rule or another step would leave).
CREATE FUNCTION pg_temp.pr_ev(p_job uuid,p_status text,p_payload jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE new_id uuid;
BEGIN
 INSERT INTO public.business_events(job_id,match_method,direction,event_type,source,payload,occurred_at,event_at)
  VALUES(p_job,'direct_job_id','inbound','client.sms_in','repair_contract',p_payload||'{"body":"Repair fixture text"}',
   now()-interval '3 days',now()-interval '3 days')
  RETURNING id INTO new_id;
 IF p_status<>'direct' THEN
  UPDATE public.business_events SET attribution_status=p_status,
   attribution_step=CASE p_status WHEN 'single_open' THEN 3 WHEN 'single_line' THEN 4 WHEN 'luna' THEN 5 WHEN 'thread' THEN 2 ELSE 1 END,
   attribution_confidence=CASE WHEN p_status='luna' THEN 0.9 ELSE 1 END,match_method='contact_id'
  WHERE id=new_id;
 END IF;
 RETURN new_id;
END $$;

CREATE FUNCTION pg_temp.pr_count(p_result jsonb,p_class text) RETURNS integer LANGUAGE sql AS $$
 SELECT (p_result->'counts'->>p_class)::integer $$;

-- 1. Shape and grants: service role only, definer with a fixed search_path.
DO $$
DECLARE f regprocedure:='public.context_payload_job_repair(boolean,integer)'; g regprocedure;
BEGIN
 FOREACH g IN ARRAY ARRAY[f,'public.context_payload_job_mismatch_rows()'::regprocedure] LOOP
  IF has_function_privilege('anon',g,'EXECUTE') OR has_function_privilege('authenticated',g,'EXECUTE') OR NOT has_function_privilege('service_role',g,'EXECUTE')
  THEN RAISE EXCEPTION 'repair grants on %',g; END IF;
  IF (SELECT proconfig IS NULL OR NOT prosecdef FROM pg_proc WHERE oid=g) THEN RAISE EXCEPTION 'repair % is not definer with a fixed search_path',g; END IF;
 END LOOP;
 IF (SELECT pg_get_function_arguments(f)) NOT LIKE 'p_dry_run boolean DEFAULT true%' THEN RAISE EXCEPTION 'repair is not a dry run by default'; END IF;
END $$;

-- 2. Classes, dry run, real run, idempotence, and the placement keeping the
-- payload job afterwards.
BEGIN;
DO $$
DECLARE a uuid; b uuid; h uuid; r_open uuid; r_luna uuid; r_threaded uuid; r_line uuid; r_direct uuid; r_thread uuid; r_missing uuid; r_held uuid; r_own uuid;
 base jsonb; dry jsonb; done jsonb; again jsonb; snap jsonb; e public.business_events; resolved public.business_events; m jsonb;
BEGIN
 base:=public.context_payload_job_repair();
 a:=pg_temp.pr_job('PR-A'); b:=pg_temp.pr_job('PR-B'); h:=pg_temp.pr_job('PR-HELD','{"do_not_schedule":true}');
 r_open:=pg_temp.pr_ev(a,'single_open',jsonb_build_object('job_id',b::text));
 r_luna:=pg_temp.pr_ev(a,'luna',jsonb_build_object('job_id',b::text));
 r_threaded:=pg_temp.pr_ev(a,'luna',jsonb_build_object('job_id',b::text));
 r_line:=pg_temp.pr_ev(a,'single_line',jsonb_build_object('job_id',b::text));
 r_direct:=pg_temp.pr_ev(a,'direct',jsonb_build_object('job_id',b::text));
 r_thread:=pg_temp.pr_ev(a,'thread',jsonb_build_object('job_id',b::text));
 r_missing:=pg_temp.pr_ev(a,'single_open',jsonb_build_object('job_id',gen_random_uuid()::text));
 r_held:=pg_temp.pr_ev(a,'luna',jsonb_build_object('job_id',h::text));
 r_own:=pg_temp.pr_ev(a,'single_open',jsonb_build_object('job_id',a::text));
 -- Luna's placement bound this email's thread to the old job.
 UPDATE public.business_events SET thread_key='pr-thread-'||r_threaded WHERE id=r_threaded;
 INSERT INTO public.event_threads(thread_key,job_id,bound_by,source_event_id) VALUES('pr-thread-'||r_threaded,a,'luna',r_threaded);
 IF EXISTS(SELECT 1 FROM public.business_events WHERE id IN (r_open,r_luna,r_threaded,r_line,r_direct,r_thread,r_missing,r_held,r_own) AND job_id IS DISTINCT FROM a)
 THEN RAISE EXCEPTION 'repair fixture: rows not placed on job A'; END IF;
 SELECT jsonb_object_agg(id::text,to_jsonb(x)) INTO snap FROM public.business_events x WHERE x.job_id IN (a,b,h);

 -- Dry run: exact class counts over the fixture, no write.
 dry:=public.context_payload_job_repair(true);
 IF dry->>'outcome'<>'dry_run'
  OR pg_temp.pr_count(dry,'repoint')-pg_temp.pr_count(base,'repoint')<>3
  OR pg_temp.pr_count(dry,'not_contact_rule')-pg_temp.pr_count(base,'not_contact_rule')<>2
  OR pg_temp.pr_count(dry,'payload_job_not_found')-pg_temp.pr_count(base,'payload_job_not_found')<>1
  OR pg_temp.pr_count(dry,'payload_job_holding')-pg_temp.pr_count(base,'payload_job_holding')<>1
  OR pg_temp.pr_count(dry,'thread_bound_elsewhere')-pg_temp.pr_count(base,'thread_bound_elsewhere')<>1
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(dry->'pairs') p WHERE p->>'from_job_id'=a::text AND p->>'to_job_id'=b::text
   AND p->>'status'='luna' AND p->>'class'='repoint' AND (p->>'rows')::int=1)
 THEN RAISE EXCEPTION 'repair dry run counts wrong % (baseline %)',dry,base; END IF;
 IF (SELECT jsonb_object_agg(id::text,to_jsonb(x)) FROM public.business_events x WHERE x.job_id IN (a,b,h)) IS DISTINCT FROM snap
 THEN RAISE EXCEPTION 'repair dry run wrote'; END IF;

 -- Real run: only the three contact-rule rows move, onto their payload job.
 done:=public.context_payload_job_repair(false);
 IF done->>'outcome'<>'done' OR (done->>'moved')::int<3 THEN RAISE EXCEPTION 'repair real run %',done; END IF;
 FOR e IN SELECT * FROM public.business_events WHERE id IN (r_open,r_luna,r_line) LOOP
  m:=e.metadata->'placement_repaired';
  IF e.job_id IS DISTINCT FROM b OR e.attribution_status<>'direct' OR e.attribution_step<>1 OR e.attribution_confidence<>1
   OR e.match_method<>'direct_job_id' OR e.metadata->>'capture_mode'<>'relink' OR e.metadata->>'capture_mode_before'<>'live'
   OR e.metadata->'source_job_binding'->>'job_id'<>b::text OR m->>'from_job_id'<>a::text OR m->>'rule'<>'payload_job_mismatch'
   OR m->>'from_status' NOT IN ('single_open','single_line','luna')
  THEN RAISE EXCEPTION 'repair moved row wrong %',to_jsonb(e); END IF;
  -- The revision store and the batch reader now accept it on its payload job.
  IF NOT public.context_event_source_admissible(e) OR NOT EXISTS(SELECT 1 FROM public.context_unread_rows(ARRAY[b]) u WHERE u.id=e.id)
  THEN RAISE EXCEPTION 'repaired row still refused %',e.id; END IF;
  -- The ladder keeps a repaired row on its payload job (custody).
  resolved:=public.resolve_context_attribution(e);
  IF resolved.job_id IS DISTINCT FROM b OR resolved.attribution_status<>'direct'
  THEN RAISE EXCEPTION 'ladder moved a repaired row off its payload job (% % %)',resolved.job_id,resolved.attribution_status,resolved.payload->>'attribution_error'; END IF;
 END LOOP;
 IF (SELECT jsonb_object_agg(id::text,to_jsonb(x)) FROM public.business_events x WHERE x.id IN (r_threaded,r_direct,r_thread,r_missing,r_held,r_own))
  IS DISTINCT FROM (SELECT jsonb_object_agg(k,v) FROM jsonb_each(snap) s(k,v) WHERE k IN (r_threaded::text,r_direct::text,r_thread::text,r_missing::text,r_held::text,r_own::text))
 THEN RAISE EXCEPTION 'repair touched a row outside the repoint class'; END IF;
 IF (SELECT job_id FROM public.event_threads WHERE source_event_id=r_threaded) IS DISTINCT FROM a
 THEN RAISE EXCEPTION 'repair changed a thread binding'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.business_events WHERE id IN (r_open,r_luna,r_threaded,r_line,r_direct,r_thread,r_missing,r_held,r_own) HAVING count(*)=9)
 THEN RAISE EXCEPTION 'repair deleted a row'; END IF;

 -- Idempotent: a second real run finds nothing of the fixture to move.
 again:=public.context_payload_job_repair(false);
 IF pg_temp.pr_count(again,'repoint')<>pg_temp.pr_count(base,'repoint') OR (again->>'moved')::int<>pg_temp.pr_count(base,'repoint')
 THEN RAISE EXCEPTION 'repair not idempotent %',again; END IF;
END $$;
ROLLBACK;

-- The dry run and the classifier run inside a read-only transaction, so a
-- read-only production read can take the counts before anyone decides.
BEGIN TRANSACTION READ ONLY;
SELECT public.context_payload_job_repair()->>'outcome' AS dry_run_outcome;
SELECT class,count(*) FROM public.context_payload_job_mismatch_rows() GROUP BY class;
ROLLBACK;

-- 3. The limit bounds a real run, and a null dry-run flag is refused.
BEGIN;
DO $$
DECLARE a uuid; b uuid; res jsonb; msg text;
BEGIN
 a:=pg_temp.pr_job('PR-LIM-A'); b:=pg_temp.pr_job('PR-LIM-B');
 PERFORM pg_temp.pr_ev(a,'single_open',jsonb_build_object('job_id',b::text)) FROM generate_series(1,3);
 res:=public.context_payload_job_repair(false,1);
 IF (res->>'moved')::int<>1 OR NOT (res->>'truncated')::boolean
  OR (SELECT count(*) FROM public.business_events WHERE job_id=b)<>1 OR (SELECT count(*) FROM public.business_events WHERE job_id=a)<>2
 THEN RAISE EXCEPTION 'repair limit not honoured %',res; END IF;
 BEGIN PERFORM public.context_payload_job_repair(NULL); msg:='ran';
 EXCEPTION WHEN OTHERS THEN msg:=SQLERRM; END;
 IF msg NOT LIKE '%p_dry_run must be true or false%' THEN RAISE EXCEPTION 'repair accepted a null dry-run flag: %',msg; END IF;
END $$;
ROLLBACK;
