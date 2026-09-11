-- B1: durable daily budget, fenced attempts and event custody. No cron activation.
CREATE TABLE IF NOT EXISTS public.context_pass_days (
 run_date date PRIMARY KEY, started_at timestamptz NOT NULL DEFAULT now(),
 attribution_done_at timestamptz, bucket_done_at timestamptz,
 finished_at timestamptz, runs integer NOT NULL DEFAULT 0 CHECK (runs >= 0),
 status text NOT NULL CHECK (status IN ('running','done','failed','skipped')),
 lease_token uuid, lease_expires_at timestamptz, retry_at timestamptz, error text
);
CREATE TABLE IF NOT EXISTS public.context_extraction_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid REFERENCES public.jobs(id),
 run_date date NOT NULL, phase text NOT NULL CHECK (phase IN ('attribution','extraction','bucket')),
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 events_in integer NOT NULL DEFAULT 0 CHECK (events_in >= 0),
 facts_new integer NOT NULL DEFAULT 0 CHECK (facts_new >= 0),
 facts_superseded integer NOT NULL DEFAULT 0 CHECK (facts_superseded >= 0),
 facts_retracted integer NOT NULL DEFAULT 0 CHECK (facts_retracted >= 0),
 tokens_in integer NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
 status text NOT NULL CHECK (status IN ('running','done','failed','skipped')), error text,
 lease_token uuid, lease_expires_at timestamptz, retry_at timestamptz,
 attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS context_extraction_runs_job_day_phase
 ON public.context_extraction_runs(job_id,run_date,phase) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS context_extraction_runs_budget ON public.context_extraction_runs(run_date,phase);
CREATE TABLE IF NOT EXISTS public.context_extraction_event_receipts (
 event_id uuid NOT NULL REFERENCES public.business_events(id),
 job_id uuid NOT NULL REFERENCES public.jobs(id),
 extractor_version text NOT NULL DEFAULT 'luna_v2' CHECK (extractor_version = 'luna_v2'),
 run_id uuid NOT NULL REFERENCES public.context_extraction_runs(id),
 processed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (event_id,job_id,extractor_version)
);
ALTER TABLE public.context_pass_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.context_extraction_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.context_extraction_event_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.context_pass_days,public.context_extraction_runs,public.context_extraction_event_receipts FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.context_pass_days,public.context_extraction_runs,public.context_extraction_event_receipts TO service_role;

CREATE TABLE IF NOT EXISTS public.context_model_call_reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 run_date date NOT NULL,
 ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 400),
 phase text NOT NULL CHECK (phase IN ('attribution','extraction','bucket')),
 run_id uuid REFERENCES public.context_extraction_runs(id),
 lease_token uuid,
 reserved_at timestamptz NOT NULL,
 CHECK ((run_id IS NULL) = (lease_token IS NULL)),
 CHECK (phase <> 'extraction' OR run_id IS NOT NULL),
 UNIQUE (run_date,ordinal)
);
ALTER TABLE public.context_model_call_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.context_model_call_reservations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.context_model_call_reservations TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_context_model_call(p_phase text,p_run_id uuid,p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_now timestamptz; v_date date; v_ordinal integer; v_id uuid; r public.context_extraction_runs;
BEGIN
 IF p_phase IS NULL OR p_phase NOT IN ('attribution','extraction','bucket')
 OR (p_run_id IS NULL) <> (p_lease_token IS NULL)
 OR (p_phase='extraction' AND p_run_id IS NULL) THEN
  RAISE EXCEPTION 'Invalid model call identity';
 END IF;
 PERFORM pg_advisory_xact_lock(20260911,1);
 IF NOT public.automation_lane_enabled(CASE WHEN p_phase='extraction' THEN 'extraction' ELSE 'attribution' END)
 THEN RETURN jsonb_build_object('outcome','paused'); END IF;
 PERFORM 1 FROM public.automation_switches WHERE id=1 FOR SHARE;
 IF NOT public.automation_lane_enabled(CASE WHEN p_phase='extraction' THEN 'extraction' ELSE 'attribution' END)
 THEN RETURN jsonb_build_object('outcome','paused'); END IF;
 IF p_run_id IS NOT NULL THEN
  SELECT * INTO r FROM public.context_extraction_runs WHERE id=p_run_id FOR UPDATE;
 END IF;
 v_now := clock_timestamp();
 v_date := (v_now AT TIME ZONE 'Australia/Perth')::date;
 IF p_run_id IS NOT NULL AND (r.id IS NULL OR r.lease_token IS DISTINCT FROM p_lease_token
 OR r.phase IS DISTINCT FROM p_phase OR r.status <> 'running'
 OR r.lease_expires_at IS NULL OR r.lease_expires_at <= v_now OR r.run_date <> v_date)
 THEN RETURN jsonb_build_object('outcome','stale'); END IF;
 SELECT coalesce(max(ordinal),0)+1 INTO v_ordinal FROM public.context_model_call_reservations WHERE run_date=v_date;
 IF v_ordinal>400 THEN RETURN jsonb_build_object('outcome','cap'); END IF;
 INSERT INTO public.context_model_call_reservations(run_date,ordinal,phase,run_id,lease_token,reserved_at)
 VALUES(v_date,v_ordinal,p_phase,p_run_id,p_lease_token,v_now) RETURNING id INTO v_id;
 RETURN jsonb_build_object('outcome','reserved','reservation_id',v_id,'run_date',v_date,'ordinal',v_ordinal);
END $$;
REVOKE ALL ON FUNCTION public.reserve_context_model_call(text,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_context_model_call(text,uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_context_extraction_run(p_job_id uuid,p_run_date date,p_phase text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.context_extraction_runs; v_lane text;
BEGIN
 IF p_job_id IS NULL OR p_run_date IS DISTINCT FROM (now() AT TIME ZONE 'Australia/Perth')::date
 OR p_phase IS NULL OR p_phase NOT IN ('attribution','extraction','bucket') THEN
  RAISE EXCEPTION 'Invalid context run identity';
 END IF;
 v_lane := CASE WHEN p_phase='extraction' THEN 'extraction' ELSE 'attribution' END;
 IF NOT public.automation_lane_enabled(v_lane) THEN RETURN jsonb_build_object('outcome','paused'); END IF;
 PERFORM pg_advisory_xact_lock(20260911,1);
 SELECT * INTO r FROM public.context_extraction_runs WHERE job_id=p_job_id AND run_date=p_run_date AND phase=p_phase FOR UPDATE;
 IF FOUND THEN
  IF r.status IN ('done','skipped') THEN RETURN jsonb_build_object('outcome','done','run',to_jsonb(r)); END IF;
  IF r.retry_at > now() THEN RETURN jsonb_build_object('outcome','paused','retry_at',r.retry_at,'run',to_jsonb(r)); END IF;
  IF r.status='running' AND r.lease_expires_at > now() THEN RETURN jsonb_build_object('outcome','busy','run',to_jsonb(r)); END IF;
  UPDATE public.context_extraction_runs SET status='running',lease_token=gen_random_uuid(),lease_expires_at=now()+interval '30 minutes',
    retry_at=NULL,finished_at=NULL,attempts=attempts+1 WHERE id=r.id RETURNING * INTO r;
 ELSE
  INSERT INTO public.context_extraction_runs(job_id,run_date,phase,status,lease_token,lease_expires_at)
   VALUES(p_job_id,p_run_date,p_phase,'running',gen_random_uuid(),now()+interval '30 minutes') RETURNING * INTO r;
 END IF;
 RETURN jsonb_build_object('outcome','claimed','run',to_jsonb(r));
END $$;

CREATE OR REPLACE FUNCTION public.finish_context_extraction_run(
 p_run_id uuid,p_lease_token uuid,p_status text,p_event_ids uuid[],p_tokens_in integer,
 p_facts_new integer,p_facts_superseded integer,p_facts_retracted integer,p_error text,p_retry_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.context_extraction_runs;
BEGIN
 IF p_status IS NULL OR p_status NOT IN ('done','failed','skipped') THEN RAISE EXCEPTION 'Invalid run completion'; END IF;
 SELECT * INTO r FROM public.context_extraction_runs WHERE id=p_run_id AND lease_token=p_lease_token
  AND status='running' AND lease_expires_at>now() FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF p_status='done' AND r.phase='extraction' THEN
  -- Receipt ownership cannot silently acknowledge another job's evidence.
  IF EXISTS (SELECT 1 FROM unnest(coalesce(p_event_ids,'{}'::uuid[])) e(id)
    LEFT JOIN public.business_events b ON b.id=e.id WHERE b.id IS NULL OR b.job_id IS DISTINCT FROM r.job_id)
    THEN RAISE EXCEPTION 'Event does not belong to run job'; END IF;
  INSERT INTO public.context_extraction_event_receipts(event_id,job_id,run_id)
   SELECT DISTINCT id,r.job_id,r.id FROM unnest(coalesce(p_event_ids,'{}'::uuid[])) e(id)
   ON CONFLICT DO NOTHING;
 END IF;
 UPDATE public.context_extraction_runs SET status=p_status,finished_at=now(),
  events_in=cardinality(coalesce(p_event_ids,'{}'::uuid[])),tokens_in=coalesce(p_tokens_in,0),
  facts_new=coalesce(p_facts_new,0),facts_superseded=coalesce(p_facts_superseded,0),facts_retracted=coalesce(p_facts_retracted,0),
  error=p_error,retry_at=p_retry_at,lease_expires_at=NULL WHERE id=r.id;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.claim_context_pass(p_run_date date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.context_pass_days;
BEGIN
 IF p_run_date IS DISTINCT FROM (now() AT TIME ZONE 'Australia/Perth')::date OR (now() AT TIME ZONE 'Australia/Perth')::time < time '06:00'
 THEN RETURN jsonb_build_object('outcome','paused'); END IF;
 IF NOT (public.automation_lane_enabled('extraction') OR public.automation_lane_enabled('attribution')) THEN RETURN jsonb_build_object('outcome','paused'); END IF;
 PERFORM pg_advisory_xact_lock(20260911,2);
 SELECT * INTO r FROM public.context_pass_days WHERE run_date=p_run_date FOR UPDATE;
 IF FOUND THEN
  IF r.status='done' THEN RETURN jsonb_build_object('outcome','done','pass',to_jsonb(r)); END IF;
  IF r.retry_at>now() THEN RETURN jsonb_build_object('outcome','paused','retry_at',r.retry_at,'pass',to_jsonb(r)); END IF;
  IF r.status='running' AND r.lease_expires_at>now() THEN RETURN jsonb_build_object('outcome','busy','pass',to_jsonb(r)); END IF;
  UPDATE public.context_pass_days SET status='running',lease_token=gen_random_uuid(),lease_expires_at=now()+interval '3 hours',retry_at=NULL,finished_at=NULL
   WHERE run_date=p_run_date RETURNING * INTO r;
 ELSE
  INSERT INTO public.context_pass_days(run_date,status,lease_token,lease_expires_at)
   VALUES(p_run_date,'running',gen_random_uuid(),now()+interval '3 hours') RETURNING * INTO r;
 END IF;
 RETURN jsonb_build_object('outcome','claimed','pass',to_jsonb(r),'lease_token',r.lease_token);
END $$;

CREATE OR REPLACE FUNCTION public.finish_context_pass(p_run_date date,p_lease_token uuid,p_status text,p_retry_at timestamptz,p_error text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_status IS NULL OR p_status NOT IN ('done','failed','skipped') THEN RAISE EXCEPTION 'Invalid pass completion'; END IF;
 UPDATE public.context_pass_days SET status=p_status,finished_at=now(),retry_at=p_retry_at,error=p_error,lease_expires_at=NULL,
  runs=(SELECT count(*) FROM public.context_model_call_reservations WHERE run_date=p_run_date)
 WHERE run_date=p_run_date AND lease_token=p_lease_token AND status='running' AND lease_expires_at>now();
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.claim_context_extraction_run(uuid,date,text),public.finish_context_extraction_run(uuid,uuid,text,uuid[],integer,integer,integer,integer,text,timestamptz),public.claim_context_pass(date),public.finish_context_pass(date,uuid,text,timestamptz,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_context_extraction_run(uuid,date,text),public.finish_context_extraction_run(uuid,uuid,text,uuid[],integer,integer,integer,integer,text,timestamptz),public.claim_context_pass(date),public.finish_context_pass(date,uuid,text,timestamptz,text) TO service_role;
CREATE OR REPLACE FUNCTION public.renew_context_pass(p_run_date date,p_lease_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE public.context_pass_days SET lease_expires_at=now()+interval '3 hours'
 WHERE run_date=p_run_date AND lease_token=p_lease_token AND status='running' AND lease_expires_at>now();
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.renew_context_pass(date,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.renew_context_pass(date,uuid) TO service_role;
