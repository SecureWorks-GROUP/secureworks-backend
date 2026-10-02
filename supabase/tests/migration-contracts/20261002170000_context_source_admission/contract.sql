-- Source admission contract. Every fixture write is rolled back. Ids, job
-- numbers and text are synthetic.

-- A job.
CREATE FUNCTION pg_temp.sa_job(p_number text,p_meta jsonb DEFAULT '{}'::jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,metadata,created_at)
  VALUES(j,'00000000-0000-0000-0000-000000000001','scheduled','fencing',p_number,p_meta,now()-interval '60 days');
 RETURN j;
END $$;

-- A worded row through the real insert trigger, placed on p_job by custody,
-- with the given payload (body added).
CREATE FUNCTION pg_temp.sa_ev(p_job uuid,p_body text,p_payload jsonb DEFAULT '{}'::jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE new_id uuid;
BEGIN
 INSERT INTO public.business_events(job_id,match_method,direction,event_type,source,payload,occurred_at,event_at)
  VALUES(p_job,'direct_job_id','inbound','client.sms_in','admission_contract',p_payload||jsonb_build_object('body',p_body),
   now()-interval '30 minutes',now()-interval '30 minutes')
  RETURNING id INTO new_id;
 RETURN new_id;
END $$;

-- What the revision store says about one row as the whole batch, on a fresh
-- running run. The store's work is always undone (the probe raises after a
-- success), so a probe never writes. Returns 'accepted' or the refusal text.
CREATE FUNCTION pg_temp.sa_b3(p_job uuid,p_event uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE run uuid:=gen_random_uuid(); lease uuid:=gen_random_uuid(); events jsonb; res jsonb; msg text;
BEGIN
 SELECT jsonb_agg(to_jsonb(e)) INTO events FROM public.business_events e WHERE e.id=p_event;
 BEGIN
  INSERT INTO public.context_extraction_runs(id,job_id,run_date,phase,status,run_seq,lease_token,lease_expires_at)
   VALUES(run,p_job,(now() AT TIME ZONE 'Australia/Perth')::date,'extraction','running',
    coalesce((SELECT max(run_seq) FROM public.context_extraction_runs WHERE job_id=p_job AND run_date=(now() AT TIME ZONE 'Australia/Perth')::date),0)+1,
    lease,now()+interval '30 minutes');
  res:=public.persist_luna_context_revision(run,lease,p_job,events,'[]','[]','[]','luna_v2',1);
  RAISE EXCEPTION 'sa_probe:%',res->>'outcome';
 EXCEPTION WHEN OTHERS THEN msg:=SQLERRM;
 END;
 RETURN CASE WHEN msg='sa_probe:inserted' THEN 'accepted' ELSE msg END;
END $$;

CREATE FUNCTION pg_temp.sa_in_batch(p_job uuid,p_event uuid) RETURNS boolean LANGUAGE sql AS $$
 SELECT EXISTS(SELECT 1 FROM public.context_extraction_events(p_job,25) b WHERE b.id=p_event) $$;

-- 1. Shape and grants: the rule is invoker SQL with no SET clause (so
-- context_unread_rows stays inlinable), and every new or replaced function is
-- service role only.
DO $$
DECLARE f regprocedure;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_event_source_admissible(public.business_events)','public.context_unread_rows(uuid[])',
  'public.context_catchup_eligible_rows(uuid[])']::regprocedure[] LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') OR NOT has_function_privilege('service_role',f,'EXECUTE')
  THEN RAISE EXCEPTION 'source admission grants on %',f; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_event_source_admissible(public.business_events)','public.context_unread_rows(uuid[])']::regprocedure[] LOOP
  IF (SELECT proconfig IS NOT NULL OR prosecdef OR prolang<>(SELECT oid FROM pg_language WHERE lanname='sql') FROM pg_proc WHERE oid=f)
  THEN RAISE EXCEPTION 'source admission: % is not inlinable-shaped (invoker SQL, no SET)',f; END IF;
 END LOOP;
 IF NOT public.automation_lane_enabled('extraction') THEN RAISE EXCEPTION 'source admission fixture: extraction lane is off'; END IF;
END $$;

-- 2. The batch reader and the revision store agree on every row shape: a row
-- is handed out exactly when B3 accepts it. A row whose payload names another
-- job (the production case), names its own job in another spelling, has no
-- attribution confidence, or is retracted in metadata is never returned;
-- a row with no payload job, a JSON null one, or its own job is.
BEGIN;
DO $$
DECLARE j uuid; k uuid; r record; got_batch boolean; got_b3 text; want boolean;
BEGIN
 j:=pg_temp.sa_job('SA-J'); k:=pg_temp.sa_job('SA-K');
 CREATE TEMP TABLE sa_rows(id uuid,label text,want boolean) ON COMMIT DROP;
 INSERT INTO sa_rows VALUES
  (pg_temp.sa_ev(j,'Plain text'),'no_payload_job',true),
  (pg_temp.sa_ev(j,'Own job',jsonb_build_object('job_id',j::text)),'payload_own_job',true),
  (pg_temp.sa_ev(j,'Null job','{"job_id":null}'),'payload_json_null',true),
  (pg_temp.sa_ev(j,'Other job',jsonb_build_object('job_id',k::text)),'payload_other_job',false),
  (pg_temp.sa_ev(j,'Upper own job',jsonb_build_object('job_id',upper(j::text))),'payload_own_job_upper',false),
  (pg_temp.sa_ev(j,'No confidence'),'no_confidence',false),
  (pg_temp.sa_ev(j,'Retracted'),'retracted',false),
  (pg_temp.sa_ev(j,'Retracted at'),'retracted_at',false),
  (pg_temp.sa_ev(j,'Luna other job',jsonb_build_object('job_id',k::text)),'luna_other_job',false),
  (pg_temp.sa_ev(j,'Single open other job',jsonb_build_object('job_id',k::text)),'single_open_other_job',false);
 UPDATE public.business_events SET attribution_confidence=NULL WHERE id=(SELECT id FROM sa_rows WHERE label='no_confidence');
 UPDATE public.business_events SET metadata=metadata||'{"retracted":"true"}' WHERE id=(SELECT id FROM sa_rows WHERE label='retracted');
 UPDATE public.business_events SET metadata=metadata||jsonb_build_object('retracted_at',now()) WHERE id=(SELECT id FROM sa_rows WHERE label='retracted_at');
 -- The production shapes: placed by Luna or by the single-open contact rule.
 UPDATE public.business_events SET attribution_status='luna',attribution_step=5,attribution_confidence=0.9,match_method='contact_id'
  WHERE id=(SELECT id FROM sa_rows WHERE label='luna_other_job');
 UPDATE public.business_events SET attribution_status='single_open',attribution_step=3,match_method='contact_id'
  WHERE id=(SELECT id FROM sa_rows WHERE label='single_open_other_job');
 IF EXISTS(SELECT 1 FROM sa_rows s JOIN public.business_events e ON e.id=s.id WHERE e.job_id IS DISTINCT FROM j OR NOT public.context_linked_status(e.attribution_status))
 THEN RAISE EXCEPTION 'source admission fixture: a row is not placed on its job'; END IF;
 FOR r IN SELECT * FROM sa_rows ORDER BY label LOOP
  got_batch:=pg_temp.sa_in_batch(j,r.id);
  got_b3:=pg_temp.sa_b3(j,r.id);
  IF got_batch IS DISTINCT FROM r.want THEN RAISE EXCEPTION 'source admission: batch reader returned=% for % (want %)',got_batch,r.label,r.want; END IF;
  IF (got_b3='accepted') IS DISTINCT FROM r.want THEN RAISE EXCEPTION 'source admission: revision store said % for % (want accepted=%)',got_b3,r.label,r.want; END IF;
  IF NOT r.want AND got_b3<>'luna_source_attribution_rejected' THEN RAISE EXCEPTION 'source admission: % refused for another reason: %',r.label,got_b3; END IF;
  IF public.context_event_source_admissible((SELECT e FROM public.business_events e WHERE e.id=r.id)) IS DISTINCT FROM r.want
  THEN RAISE EXCEPTION 'source admission: rule disagrees with the store for %',r.label; END IF;
 END LOOP;
 -- The whole batch the worker would get now persists in one revision.
 IF (SELECT count(*) FROM public.context_extraction_events(j,25))<>3 THEN RAISE EXCEPTION 'source admission: batch size wrong'; END IF;
END $$;
ROLLBACK;

-- 3. A refused row never makes a job due and is left untouched: a job whose
-- only unread row names another job has nothing unread and an empty batch;
-- the row keeps its job, status and payload.
BEGIN;
DO $$
DECLARE j uuid; k uuid; ev uuid; before jsonb; c jsonb;
BEGIN
 j:=pg_temp.sa_job('SA-ONLY'); k:=pg_temp.sa_job('SA-OTHER');
 ev:=pg_temp.sa_ev(j,'Only row, other job',jsonb_build_object('job_id',k::text));
 UPDATE public.business_events SET attribution_status='single_open',attribution_step=3,match_method='contact_id' WHERE id=ev;
 SELECT to_jsonb(e) INTO before FROM public.business_events e WHERE e.id=ev;
 c:=public.context_job_cadence(j);
 IF (c->>'unread_count')::int<>0 OR (c->>'due')::boolean OR EXISTS(SELECT 1 FROM public.context_extraction_events(j,25))
  OR EXISTS(SELECT 1 FROM public.context_unread_rows(ARRAY[j])) OR EXISTS(SELECT 1 FROM public.context_cadence_pool() p WHERE p=j)
 THEN RAISE EXCEPTION 'source admission: a refused row still counts as unread %',c; END IF;
 IF (SELECT to_jsonb(e) FROM public.business_events e WHERE e.id=ev) IS DISTINCT FROM before
 THEN RAISE EXCEPTION 'source admission: reading moved or changed the refused row'; END IF;
END $$;
ROLLBACK;

-- 4. Catch-up: a listed job's refused row is not pending, so one read of its
-- good rows completes the job instead of failing it every day.
BEGIN;
DO $$
DECLARE j uuid; k uuid; good uuid; bad uuid; run uuid:=gen_random_uuid(); lease uuid:=gen_random_uuid(); events jsonb; res jsonb;
BEGIN
 j:=pg_temp.sa_job('SA-CU'); k:=pg_temp.sa_job('SA-CU-OTHER');
 good:=pg_temp.sa_ev(j,'Good catch-up row');
 bad:=pg_temp.sa_ev(j,'Misplaced catch-up row',jsonb_build_object('job_id',k::text));
 UPDATE public.business_events SET attribution_status='luna',attribution_step=5,attribution_confidence=0.9,match_method='contact_id' WHERE id=bad;
 INSERT INTO public.context_catchup_jobs(job_id,job_number,priority) VALUES(j,'SA-CU',1);
 IF EXISTS(SELECT 1 FROM public.context_catchup_pending_rows(ARRAY[j]) p WHERE p.id=bad)
  OR NOT EXISTS(SELECT 1 FROM public.context_catchup_pending_rows(ARRAY[j]) p WHERE p.id=good)
 THEN RAISE EXCEPTION 'source admission: catch-up pending rows wrong'; END IF;
 SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) INTO events FROM public.business_events e WHERE e.id IN (SELECT b.id FROM public.context_extraction_events(j,25) b);
 IF jsonb_array_length(events)<>1 OR events->0->>'id'<>good::text THEN RAISE EXCEPTION 'source admission: catch-up batch %',events; END IF;
 INSERT INTO public.context_extraction_runs(id,job_id,run_date,phase,status,run_seq,lease_token,lease_expires_at)
  VALUES(run,j,(now() AT TIME ZONE 'Australia/Perth')::date,'extraction','running',1,lease,now()+interval '30 minutes');
 res:=public.persist_luna_context_revision(run,lease,j,events,'[]','[]','[]','luna_v2',1);
 IF res->>'outcome'<>'inserted' THEN RAISE EXCEPTION 'source admission: catch-up batch not persisted %',res; END IF;
 IF (SELECT done_run_id FROM public.context_catchup_jobs WHERE job_id=j) IS DISTINCT FROM run
 THEN RAISE EXCEPTION 'source admission: catch-up job not done after reading its good rows'; END IF;
 IF (SELECT job_id FROM public.business_events WHERE id=bad) IS DISTINCT FROM j
 THEN RAISE EXCEPTION 'source admission: the refused row was moved'; END IF;
END $$;
ROLLBACK;
