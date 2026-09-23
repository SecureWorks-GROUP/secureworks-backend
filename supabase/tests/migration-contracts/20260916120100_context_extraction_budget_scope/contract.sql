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
 -- K1 (20260924030000) replaced D4's candidates and batch rules: our own
 -- messages now wake a read on their own and a job is due on the cadence rule.
 -- What stays from D4: holding jobs never read, archived and internal-only jobs
 -- are read, and our messages ride along in the batch.
 IF EXISTS(SELECT 1 FROM public.context_extraction_events(holding,25)) OR public.context_job_cadence(holding)->>'blocked_reason'<>'holding_job'
 THEN RAISE EXCEPTION 'D4 holding job admitted'; END IF;
 SELECT count(*) INTO n FROM public.context_extraction_events(real_job,25);
 IF n<>3 THEN RAISE EXCEPTION 'D4 real job batch must carry the inbound row and our own messages as context, got %',n; END IF;
 IF (SELECT count(*) FROM public.context_extraction_events(ours_only,25))<>2 THEN RAISE EXCEPTION 'K1 outbound-only job must be read'; END IF;
 IF (SELECT count(*) FROM public.context_extraction_events(archived,25))<>1 THEN RAISE EXCEPTION 'D4 archived non-holding inbound batch'; END IF;
 IF (SELECT count(*) FROM public.context_extraction_events(internal_only,25))<>1 THEN RAISE EXCEPTION 'D4 internal-only batch'; END IF;
 IF (public.context_job_cadence(archived)->>'waking_count')::int<>1 OR (public.context_job_cadence(internal_only)->>'waking_count')::int<>1
 THEN RAISE EXCEPTION 'D4 archived and internal evidence must wake'; END IF;
 IF has_function_privilege('anon','public.context_job_extractable(public.jobs)','EXECUTE') THEN RAISE EXCEPTION 'D4 public predicate'; END IF;
END $$;
ROLLBACK;
