-- Roll back A1-BE (20260924060000_context_attribution_attempts).
--
-- Restores reserve_context_model_call(text,uuid,uuid) to the live production
-- body byte for byte (md5(prosrc) 569a31f3e75c7e5e5e75e85cc628adde, read from
-- production 23 Sep 2026) and removes everything A1-BE added: the outcome
-- overload, record_attribution_error, context_attribution_due, the private
-- helpers and the attempt table. The legacy three-argument
-- attribute_context_event_with_luna was never touched and stays as it is.
--
-- Rows the outcome overload rested as 'unplaced' stay 'unplaced' (F1 owns that
-- status; its rollback refuses while they exist). They keep candidate_job_ids
-- and metadata.luna_outcome and remain in each candidate's not-yet-placed lane.
-- Re-offering them to Luna is a separate, logged data run, not this file.
--
-- Roll back A1-RT first: once this runs, the outcome overload, the error
-- recorder and the due read no longer exist. Refuses if a later slice has
-- replaced reserve_context_model_call.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.reserve_context_model_call(text,uuid,uuid)'))
    IS DISTINCT FROM '86bfd48365b6aa26c4400ec2b5d476c3'
 THEN RAISE EXCEPTION 'a1_rollback_refused: reserve_context_model_call is not the A1-BE body; a later slice replaced it, roll that back first'; END IF;
END $$;

DROP FUNCTION IF EXISTS public.context_attribution_due(integer);
DROP FUNCTION IF EXISTS public.record_attribution_error(uuid,text);
DROP FUNCTION IF EXISTS public.attribute_context_event_with_luna(uuid,uuid,numeric,text);
DROP FUNCTION IF EXISTS public.context_attribution_record_attempt(public.business_events,text,text);
DROP FUNCTION IF EXISTS public.context_attribution_candidate_hash(public.business_events);
DROP FUNCTION IF EXISTS public.context_attribution_next_perth_day(timestamptz);
DROP TABLE IF EXISTS public.context_attribution_attempts;

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

DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.reserve_context_model_call(text,uuid,uuid)'))
    IS DISTINCT FROM '569a31f3e75c7e5e5e75e85cc628adde'
 THEN RAISE EXCEPTION 'a1_rollback_postcheck: reserve_context_model_call is not the live pre-image'; END IF;
END $$;
