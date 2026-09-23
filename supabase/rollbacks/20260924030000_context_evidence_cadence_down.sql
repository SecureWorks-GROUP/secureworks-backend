-- Down migration for 20260924030000_context_evidence_cadence (slice K1).
--
-- Restores every replaced function to its live production pre-image, byte for
-- byte (md5 checked at the end), and drops the functions K1 added. The claim
-- is restored as a rollback version (cadence.md review S6): run_seq and the
-- run_seq index stay, so a job may already hold several runs today; the
-- rollback claim reads the newest and treats any completed read today as done.
-- Kept on purpose (no data is lost): context_extraction_runs.run_seq and its
-- index, context_pass_days.lease_takeovers, the two business_events indexes,
-- staff_ghl_users and every metadata.written_as already recorded. The one-run-
-- a-day index is not recreated: rows written under K1 would violate it.
-- Immediate stop needs no rollback: switch the extraction lane off.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- The live trigger body (production, read 23 Sep 2026).
CREATE OR REPLACE FUNCTION public.attribute_business_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.context_captured_at IS NULL THEN
    NEW.context_captured_at := clock_timestamp();
  END IF;
  NEW := public.resolve_context_attribution(NEW);
  RETURN NEW;
END $function$;

-- Rollback claim (S6): one run a day again, read from the newest run_seq.
CREATE OR REPLACE FUNCTION public.claim_context_extraction_run(p_job_id uuid,p_run_date date,p_phase text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.context_extraction_runs; d public.context_extraction_runs; v_lane text;
BEGIN
 IF p_job_id IS NULL OR p_run_date IS DISTINCT FROM (now() AT TIME ZONE 'Australia/Perth')::date
 OR p_phase IS NULL OR p_phase NOT IN ('attribution','extraction','bucket') THEN
  RAISE EXCEPTION 'Invalid context run identity';
 END IF;
 v_lane := CASE WHEN p_phase='extraction' THEN 'extraction' ELSE 'attribution' END;
 IF NOT public.automation_lane_enabled(v_lane) THEN RETURN jsonb_build_object('outcome','paused'); END IF;
 PERFORM pg_advisory_xact_lock(20260911,1);
 SELECT * INTO d FROM public.context_extraction_runs WHERE job_id=p_job_id AND run_date=p_run_date AND phase=p_phase AND status IN ('done','skipped')
  ORDER BY run_seq DESC LIMIT 1;
 IF FOUND THEN RETURN jsonb_build_object('outcome','done','run',to_jsonb(d)); END IF;
 SELECT * INTO r FROM public.context_extraction_runs WHERE job_id=p_job_id AND run_date=p_run_date AND phase=p_phase
  ORDER BY run_seq DESC LIMIT 1 FOR UPDATE;
 IF FOUND THEN
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


-- Pass lease: the 20260911170001 bodies (06:00 gate, 3-hour lease, done terminal).

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

CREATE OR REPLACE FUNCTION public.renew_context_pass(p_run_date date,p_lease_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE public.context_pass_days SET lease_expires_at=now()+interval '3 hours'
 WHERE run_date=p_run_date AND lease_token=p_lease_token AND status='running' AND lease_expires_at>now();
 RETURN FOUND;
END $$;

-- Candidates and batch: the 20260916120100 bodies.

CREATE OR REPLACE FUNCTION public.context_extraction_events(p_job_id uuid,p_limit integer DEFAULT 25) RETURNS SETOF public.business_events
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH admitted AS (
 SELECT public.automation_lane_enabled('extraction')
  AND EXISTS(SELECT 1 FROM public.jobs j WHERE j.id=p_job_id AND public.context_job_extractable(j))
  AND EXISTS(SELECT 1 FROM public.business_events fresh WHERE fresh.job_id=p_job_id AND fresh.context_captured_at IS NOT NULL
   AND fresh.attribution_status IN ('direct','thread','single_open','single_line','luna') AND fresh.direction IS DISTINCT FROM 'outbound') AS ok
 ), unreceipted AS (
 SELECT e.* FROM public.business_events e WHERE (SELECT ok FROM admitted) AND e.job_id=p_job_id
 AND e.attribution_status IN ('direct','thread','single_open','single_line','luna')
 AND btrim(public.context_event_text(e))<>''
 AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r WHERE r.event_id=e.id AND r.job_id=p_job_id AND r.extractor_version='luna_v2')
 ), eligible AS (
 SELECT u.* FROM unreceipted u WHERE EXISTS(SELECT 1 FROM unreceipted i WHERE i.direction IS DISTINCT FROM 'outbound')
 ), anchor AS (
 SELECT e.* FROM public.business_events e WHERE e.job_id=p_job_id
 AND e.direction IS DISTINCT FROM 'outbound' AND e.attribution_status IN ('direct','thread','single_open','single_line','luna')
 AND btrim(public.context_event_text(e))<>''
 ORDER BY CASE WHEN EXISTS(SELECT 1 FROM eligible u WHERE u.id=e.id) THEN 0 ELSE 1 END,coalesce(e.event_at,e.occurred_at),e.id LIMIT 1
 ), combined AS (
 SELECT * FROM eligible UNION SELECT * FROM anchor WHERE EXISTS(SELECT 1 FROM eligible)
 ), selected AS (
 SELECT e.* FROM combined e WHERE EXISTS(SELECT 1 FROM anchor)
 ORDER BY CASE WHEN e.id=(SELECT id FROM anchor) THEN 0 ELSE 1 END,coalesce(e.event_at,e.occurred_at),e.id
 LIMIT greatest(0,least(coalesce(p_limit,25),25))
 ) SELECT * FROM selected ORDER BY coalesce(event_at,occurred_at),id
$$;

CREATE OR REPLACE FUNCTION public.context_extraction_candidates(p_limit integer DEFAULT 400) RETURNS TABLE(job_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT e.job_id FROM public.business_events e JOIN public.jobs j ON j.id=e.job_id
 WHERE public.automation_lane_enabled('extraction') AND e.job_id IS NOT NULL AND public.context_job_extractable(j)
 AND e.direction IS DISTINCT FROM 'outbound'
 AND btrim(public.context_event_text(e))<>''
 AND EXISTS(SELECT 1 FROM public.business_events fresh WHERE fresh.job_id=e.job_id AND fresh.context_captured_at IS NOT NULL AND fresh.attribution_status IN ('direct','thread','single_open','single_line','luna') AND fresh.direction IS DISTINCT FROM 'outbound')
 AND e.attribution_status IN ('direct','thread','single_open','single_line','luna')
 AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r WHERE r.event_id=e.id AND r.job_id=e.job_id AND r.extractor_version='luna_v2')
 AND NOT EXISTS(SELECT 1 FROM public.context_extraction_runs r WHERE r.job_id=e.job_id AND r.run_date=(now() AT TIME ZONE 'Australia/Perth')::date AND r.phase='extraction' AND r.status IN ('done','skipped'))
 GROUP BY e.job_id ORDER BY EXISTS(SELECT 1 FROM public.context_extraction_runs retry WHERE retry.job_id=e.job_id AND retry.run_date=(now() AT TIME ZONE 'Australia/Perth')::date AND retry.phase='extraction' AND retry.status IN ('running','failed')) DESC,min(coalesce(e.event_at,e.occurred_at)),e.job_id LIMIT greatest(0,least(coalesce(p_limit,400),400))
$$;

-- Status: the F1 stub and the F1 ready count.

CREATE OR REPLACE FUNCTION public.context_ready_jobs_count(p_cap integer DEFAULT 400) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH lane AS (SELECT public.automation_lane_enabled('extraction') AS enabled),
 today AS (SELECT (now() AT TIME ZONE 'Australia/Perth')::date AS d),
 pending AS MATERIALIZED (
  SELECT e.job_id FROM public.business_events e
  WHERE (SELECT enabled FROM lane) AND e.job_id IS NOT NULL
   AND e.attribution_status IN ('direct','thread','single_open','single_line','luna')
   AND e.direction IS DISTINCT FROM 'outbound'
   AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r WHERE r.event_id=e.id AND r.job_id=e.job_id AND r.extractor_version='luna_v2')
   AND btrim(public.context_event_text(e))<>''
  GROUP BY e.job_id
 )
 SELECT count(*)::integer FROM (
  SELECT p.job_id FROM pending p JOIN public.jobs j ON j.id=p.job_id
  WHERE coalesce(j.metadata->>'do_not_schedule','') NOT IN ('true','1')
   AND EXISTS(SELECT 1 FROM public.business_events fresh WHERE fresh.job_id=p.job_id AND fresh.context_captured_at IS NOT NULL
    AND fresh.attribution_status IN ('direct','thread','single_open','single_line','luna') AND fresh.direction IS DISTINCT FROM 'outbound')
   AND NOT EXISTS(SELECT 1 FROM public.context_extraction_runs r, today WHERE r.job_id=p.job_id AND r.run_date=today.d AND r.phase='extraction' AND r.status IN ('done','skipped'))
  LIMIT greatest(0,least(coalesce(p_cap,400),400))
 ) ready
$$;

CREATE OR REPLACE FUNCTION public.context_cadence_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT NULL::jsonb $$;


DROP FUNCTION IF EXISTS public.context_job_freshness(uuid);
DROP FUNCTION IF EXISTS public.context_extraction_event_flags(uuid,uuid[]);
DROP FUNCTION IF EXISTS public.renew_context_extraction_run(uuid,uuid);
DROP FUNCTION IF EXISTS public.context_cadence_pool();
DROP FUNCTION IF EXISTS public.context_job_cadence(uuid);
DROP FUNCTION IF EXISTS public.context_jobs_cadence(uuid[]);
DROP FUNCTION IF EXISTS public.context_unread_events(uuid);
DROP FUNCTION IF EXISTS public.context_unread_rows(uuid[]);
DROP FUNCTION IF EXISTS public.context_event_is_ours(public.business_events);
DROP FUNCTION IF EXISTS public.context_event_status_only(public.business_events);
DROP FUNCTION IF EXISTS public.context_request_role();
DROP FUNCTION IF EXISTS public.context_cadence_policy();

REVOKE ALL ON FUNCTION public.claim_context_extraction_run(uuid,date,text),public.claim_context_pass(date),public.renew_context_pass(date,uuid),
 public.finish_context_pass(date,uuid,text,timestamptz,text),public.context_extraction_events(uuid,integer),public.context_extraction_candidates(integer),
 public.context_ready_jobs_count(integer),public.context_cadence_status(),public.attribute_business_event() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_context_extraction_run(uuid,date,text),public.claim_context_pass(date),public.renew_context_pass(date,uuid),
 public.finish_context_pass(date,uuid,text,timestamptz,text),public.context_extraction_events(uuid,integer),public.context_extraction_candidates(integer),
 public.context_ready_jobs_count(integer),public.context_cadence_status() TO service_role;

-- Prove the live bodies are back.
DO $$
DECLARE x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.attribute_business_event()','c399dfbebcd120a4b0741a9130a973bf'),
  ('public.claim_context_pass(date)','5085741c2f41def9244717b16f15ffb2'),
  ('public.renew_context_pass(date,uuid)','a45e3fd2e2d7ef34ea323deddfb9abe6'),
  ('public.finish_context_pass(date,uuid,text,timestamptz,text)','d41992ac30bea7c884a5856395c233cd'),
  ('public.context_extraction_events(uuid,integer)','b20069eae64c43cf4d9315f6ffc8e2b7'),
  ('public.context_extraction_candidates(integer)','6428bee63b2db436dbe1c6dcaeafd69e'),
  ('public.context_cadence_status()','155104bfb08b8b3c2f98bdec089d4ee4'),
  ('public.context_ready_jobs_count(integer)','67e55f87c9e53c4f6640a0936d8d279b')) AS t(sig,md5) LOOP
  SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid=to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.md5 THEN RAISE EXCEPTION 'k1 rollback: % is not the pre-image (%)',x.sig,live; END IF;
 END LOOP;
END $$;
