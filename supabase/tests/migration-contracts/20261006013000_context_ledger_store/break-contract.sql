-- Ship the ledger without its live reserve: this migration's admission with
-- the two reserve refusals taken out, so ledger reads could spend the calls
-- kept for new customer messages. The contract's live reserve check must
-- catch it (every other phase still answers as before, so section 2 passes).
CREATE OR REPLACE FUNCTION public.reserve_context_model_call(p_phase text,p_run_id uuid,p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_now timestamptz; v_date date; v_ordinal integer; v_id uuid; r public.context_extraction_runs;
 v_ledger public.context_ledger_settings; v_pol jsonb; v_calls integer; v_reserve_day integer; v_reserve_morning integer;
BEGIN
 IF p_phase IS NULL OR p_phase NOT IN ('attribution','extraction','bucket','vision','ledger')
 OR (p_run_id IS NULL) <> (p_lease_token IS NULL)
 OR (p_phase IN ('extraction','ledger') AND p_run_id IS NULL)
 OR (p_phase='vision' AND p_run_id IS NOT NULL) THEN
  RAISE EXCEPTION 'Invalid model call identity';
 END IF;
 PERFORM pg_advisory_xact_lock(20260911,1);
 IF NOT public.automation_lane_enabled(CASE WHEN p_phase IN ('extraction','vision','ledger') THEN 'extraction' ELSE 'attribution' END)
 OR (p_phase='vision' AND NOT public.automation_lane_enabled('capture'))
 THEN RETURN jsonb_build_object('outcome','paused'); END IF;
 PERFORM 1 FROM public.automation_switches WHERE id=1 FOR SHARE;
 IF NOT public.automation_lane_enabled(CASE WHEN p_phase IN ('extraction','vision','ledger') THEN 'extraction' ELSE 'attribution' END)
 OR (p_phase='vision' AND NOT public.automation_lane_enabled('capture'))
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
 -- ledger: only while the lane is switched on, within its own daily ceiling,
 -- and never inside the live reserve (the same line the catch-up backlog
 -- stops at, all day and before noon).
 IF p_phase='ledger' THEN
  SELECT * INTO v_ledger FROM public.context_ledger_settings WHERE id;
  IF v_ledger.id IS NULL OR v_ledger.mode='off' THEN RETURN jsonb_build_object('outcome','ledger_off'); END IF;
  IF (SELECT count(*) FROM public.context_model_call_reservations WHERE run_date=v_date AND phase='ledger')>=v_ledger.calls_per_day
  THEN RETURN jsonb_build_object('outcome','ledger_budget','reason','ledger_calls_per_day','run_date',v_date,'limit',v_ledger.calls_per_day); END IF;
  v_pol := public.context_cadence_policy();
  SELECT coalesce(s.live_reserve_calls_day,100), coalesce(s.live_reserve_calls_morning,100) INTO v_reserve_day, v_reserve_morning
  FROM (SELECT 1) one LEFT JOIN public.context_cadence_settings s ON s.id;
  SELECT count(*) INTO v_calls FROM public.context_model_call_reservations WHERE run_date=v_date;
 END IF;
 -- B-5b: vision only while the job reads keep their share, and within its own daily cap.
 IF p_phase='vision' THEN
  IF v_ordinal>(public.context_document_vision_policy()->>'shared_calls_ceiling')::integer
  THEN RETURN jsonb_build_object('outcome','vision_reserve','run_date',v_date,
   'ceiling',(public.context_document_vision_policy()->>'shared_calls_ceiling')::integer); END IF;
  IF (SELECT count(*) FROM public.context_model_call_reservations WHERE run_date=v_date AND phase='vision')
   >=public.context_document_vision_daily_cap()
  THEN RETURN jsonb_build_object('outcome','vision_budget','run_date',v_date,'limit',public.context_document_vision_daily_cap()); END IF;
 END IF;
 INSERT INTO public.context_model_call_reservations(run_date,ordinal,phase,run_id,lease_token,reserved_at)
 VALUES(v_date,v_ordinal,p_phase,p_run_id,p_lease_token,v_now) RETURNING id INTO v_id;
 RETURN jsonb_build_object('outcome','reserved','reservation_id',v_id,'run_date',v_date,'ordinal',v_ordinal);
END $$;
