-- Rollback of 20261006001000_context_document_vision (gap plan B-5b).
--
-- Restores the A1 reservation body (20260924060000, md5
-- 86bfd48365b6aa26c4400ec2b5d476c3) and the three-phase CHECK on
-- context_model_call_reservations, and drops the vision reader's functions
-- and tables. Vision reservation rows are deleted first because the restored
-- CHECK cannot hold them; ordinals are never reused (the next ordinal is the
-- day's max plus one), so the day's cap still counts every call already made.
-- Evidence rows already saved stay in business_events.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DELETE FROM public.context_model_call_reservations WHERE phase='vision';
DO $chk$
DECLARE c record;
BEGIN
 FOR c IN SELECT conname FROM pg_constraint
  WHERE conrelid='public.context_model_call_reservations'::regclass AND contype='c'
   AND pg_get_constraintdef(oid)=$d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'vision'::text])))$d$ LOOP
  EXECUTE format('ALTER TABLE public.context_model_call_reservations DROP CONSTRAINT %I',c.conname);
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.context_model_call_reservations'::regclass AND contype='c'
   AND pg_get_constraintdef(oid)=$d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text])))$d$) THEN
  ALTER TABLE public.context_model_call_reservations ADD CONSTRAINT context_model_call_reservations_phase_check
   CHECK (phase IN ('attribution','extraction','bucket'));
 END IF;
END $chk$;

-- The A1 body, as 20260924060000 wrote it.
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
 -- A1: attribution may use at most 60 of the day's 400 calls.
 IF p_phase='attribution' AND (SELECT count(*) FROM public.context_model_call_reservations
   WHERE run_date=v_date AND phase='attribution')>=60
 THEN RETURN jsonb_build_object('outcome','attribution_budget','run_date',v_date,'limit',60); END IF;
 INSERT INTO public.context_model_call_reservations(run_date,ordinal,phase,run_id,lease_token,reserved_at)
 VALUES(v_date,v_ordinal,p_phase,p_run_id,p_lease_token,v_now) RETURNING id INTO v_id;
 RETURN jsonb_build_object('outcome','reserved','reservation_id',v_id,'run_date',v_date,'ordinal',v_ordinal);
END $$;
REVOKE ALL ON FUNCTION public.reserve_context_model_call(text,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_context_model_call(text,uuid,uuid) TO service_role;

DROP FUNCTION IF EXISTS public.context_document_vision_status();
DROP FUNCTION IF EXISTS public.context_document_vision_admission();
DROP FUNCTION IF EXISTS public.context_document_vision_leased(uuid);
DROP FUNCTION IF EXISTS public.record_context_document_vision(jsonb);
DROP FUNCTION IF EXISTS public.claim_context_document_vision(jsonb);
DROP FUNCTION IF EXISTS public.context_document_vision_backoff(integer);
DROP FUNCTION IF EXISTS public.context_document_vision_due(integer);
DROP TABLE IF EXISTS public.context_document_vision_reads;
DROP FUNCTION IF EXISTS public.context_document_vision_daily_cap();
DROP TABLE IF EXISTS public.context_document_vision_settings;
DROP FUNCTION IF EXISTS public.context_document_vision_flag();
DROP FUNCTION IF EXISTS public.context_document_vision_policy();
