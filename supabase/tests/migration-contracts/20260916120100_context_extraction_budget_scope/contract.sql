BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; real_job uuid:=gen_random_uuid(); ours_only uuid:=gen_random_uuid();
 archived uuid:=gen_random_uuid(); holding uuid:=gen_random_uuid(); internal_only uuid:=gen_random_uuid(); n integer; ids uuid[];
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,metadata) VALUES
  (real_job,org,'accepted','patio','D4-REAL','{}'),
  (ours_only,org,'accepted','patio','D4-OURS-ONLY','{}'),
  (archived,org,'archived','fencing','D4-ARCHIVED','{}'),
  (holding,org,'accepted','fencing','D4-HOLDING','{"purpose":"pdf_unlock_bucket","do_not_schedule":true}'),
  (internal_only,org,'accepted','patio','D4-INTERNAL','{}');
 -- One inbound plus two of our own messages: the job runs and our messages ride along.
 INSERT INTO public.business_events(job_id,match_method,direction,context_captured_at,event_at,payload) VALUES
  (real_job,'direct_job_id','outbound',now(),now()-interval '3 days','{"body":"Quote sent, let us know"}'),
  (real_job,'direct_job_id','inbound',now(),now()-interval '2 days','{"body":"Yes please book us in"}'),
  (real_job,'direct_job_id','outbound',now(),now()-interval '1 day','{"body":"Booked for Monday"}');
 -- Only our own messages: never a candidate, never an event batch.
 INSERT INTO public.business_events(job_id,match_method,direction,context_captured_at,event_at,payload) VALUES
  (ours_only,'direct_job_id','outbound',now(),now()-interval '2 days','{"body":"Chasing the deposit"}'),
  (ours_only,'direct_job_id','outbound',now(),now()-interval '1 day','{"body":"Second chase"}');
 -- Holding jobs stay excluded. An archived non-holding job with new inbound mail is extractable.
 INSERT INTO public.business_events(job_id,match_method,direction,context_captured_at,event_at,payload) VALUES
  (archived,'direct_job_id','inbound',now(),now()-interval '1 day','{"body":"Old job question"}'),
  (holding,'direct_job_id','inbound',now(),now()-interval '1 day','{"body":"Unallocated supplier bill attached"}');
 -- A staff note (internal) is real evidence.
 INSERT INTO public.business_events(job_id,match_method,direction,context_captured_at,event_at,payload) VALUES
  (internal_only,'direct_job_id','internal',now(),now()-interval '1 day','{"body":"Client rang, wants the gate moved"}');
 SELECT array_agg(job_id) INTO ids FROM public.context_extraction_candidates(400);
 IF NOT (real_job=ANY(ids)) THEN RAISE EXCEPTION 'D4 real job with inbound evidence must be a candidate'; END IF;
 IF NOT (internal_only=ANY(ids)) THEN RAISE EXCEPTION 'D4 internal evidence must qualify a job'; END IF;
 IF NOT (archived=ANY(ids)) THEN RAISE EXCEPTION 'D4 archived non-holding job with inbound mail must be extractable'; END IF;
 IF ours_only=ANY(ids) THEN RAISE EXCEPTION 'D4 outbound-only job admitted'; END IF;
 IF holding=ANY(ids) THEN RAISE EXCEPTION 'D4 holding job admitted'; END IF;
 SELECT count(*) INTO n FROM public.context_extraction_events(real_job,25);
 IF n<>3 THEN RAISE EXCEPTION 'D4 real job batch must carry the inbound row and our own messages as context, got %',n; END IF;
 IF (SELECT count(*) FROM public.context_extraction_events(ours_only,25))<>0 THEN RAISE EXCEPTION 'D4 outbound-only batch produced events'; END IF;
 IF (SELECT count(*) FROM public.context_extraction_events(archived,25))<>1 THEN RAISE EXCEPTION 'D4 archived non-holding inbound batch'; END IF;
 IF (SELECT count(*) FROM public.context_extraction_events(holding,25))<>0 THEN RAISE EXCEPTION 'D4 holding job batch produced events'; END IF;
 IF (SELECT count(*) FROM public.context_extraction_events(internal_only,25))<>1 THEN RAISE EXCEPTION 'D4 internal-only batch'; END IF;
 -- Once the inbound row is receipted, the remaining outbound rows alone do not re-run the job.
 INSERT INTO public.context_extraction_runs(job_id,run_date,phase,status,lease_token,lease_expires_at) VALUES(real_job,(now() AT TIME ZONE 'Australia/Perth')::date-1,'extraction','done',gen_random_uuid(),now());
 INSERT INTO public.context_extraction_event_receipts(event_id,job_id,run_id) SELECT id,job_id,(SELECT id FROM public.context_extraction_runs WHERE job_id=real_job) FROM public.business_events WHERE job_id=real_job AND direction='inbound';
 IF EXISTS(SELECT 1 FROM public.context_extraction_candidates(400) c WHERE c.job_id=real_job) THEN RAISE EXCEPTION 'D4 receipted inbound left outbound-only job as candidate'; END IF;
 IF (SELECT count(*) FROM public.context_extraction_events(real_job,25))<>0 THEN RAISE EXCEPTION 'D4 outbound remainder batched alone'; END IF;
 IF has_function_privilege('anon','public.context_job_extractable(public.jobs)','EXECUTE') THEN RAISE EXCEPTION 'D4 public predicate'; END IF;
END $$;
ROLLBACK;
