-- Rollback of 20261009100000_context_job_story_text: the saved job story is
-- removed and the model call admission goes back to the call budget body
-- (20261006060000, md5 0d741538d7874ce63d48e54d8645d18c) and its comment, byte
-- for byte.
--
-- Story model calls already reserved stay: they are the audit of real model
-- spend. The reservations' phase list narrows back to the ledger store's
-- (20261006013000), NOT VALID while story rows remain (no new story call is
-- admitted; the old rows stay). The written stories and the request queue are
-- dropped (a story is the worker's words from the card and the AI notes; the
-- writer can write it again), with every story function and the switch row
-- feature_flags.context_job_story_text_v1. Nothing else is touched: no other
-- flag row, no business row.
--
-- Refuses unless the admission is this migration's body or already the
-- call budget's (a second run changes nothing).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE live text;
BEGIN
 SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid = to_regprocedure('public.reserve_context_model_call(text,uuid,uuid)');
 IF live IS NULL OR live NOT IN ('25a5b5f208af726d47e952f98cecef56', '0d741538d7874ce63d48e54d8645d18c') THEN
  RAISE EXCEPTION 'context_job_story_text_down_refused: reserve_context_model_call md5 % is a later body; roll that back first', coalesce(live, '<missing>');
 END IF;
END $guard$;

-- 1. The admission back to the call budget body (20261006060000), byte for byte.
CREATE OR REPLACE FUNCTION public.reserve_context_model_call(p_phase text,p_run_id uuid,p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_now timestamptz; v_date date; v_ordinal integer; v_id uuid; r public.context_extraction_runs;
 v_ledger_mode text; v_ledger_calls integer; v_pol jsonb; v_calls integer; v_reserve_day integer; v_reserve_morning integer;
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
 -- call budget (20261006060000): the day's cap and attribution's share are the
 -- policy's numbers (owner ruling 6 Oct 2026: 1,000 calls, 300 for placement).
 v_pol := public.context_cadence_policy();
 SELECT coalesce(max(ordinal),0)+1 INTO v_ordinal FROM public.context_model_call_reservations WHERE run_date=v_date;
 IF v_ordinal>(v_pol->>'model_call_cap')::integer THEN RETURN jsonb_build_object('outcome','cap'); END IF;
 -- A1: attribution may use at most attribution_calls_day of the day's calls.
 IF p_phase='attribution' AND (SELECT count(*) FROM public.context_model_call_reservations
   WHERE run_date=v_date AND phase='attribution')>=(v_pol->>'attribution_calls_day')::integer
 THEN RETURN jsonb_build_object('outcome','attribution_budget','run_date',v_date,'limit',(v_pol->>'attribution_calls_day')::integer); END IF;
 -- ledger: only while the lane is switched on, within its own daily ceiling,
 -- and never inside its own live reserve (context_ledger_settings, all day and
 -- before noon), whatever reserve the fact backlog keeps.
 IF p_phase='ledger' THEN
  -- plain variables, read only here: no other phase depends on the ledger table
  SELECT st.mode, st.calls_per_day, st.live_reserve_calls, st.live_reserve_calls_morning
  INTO v_ledger_mode, v_ledger_calls, v_reserve_day, v_reserve_morning FROM public.context_ledger_settings st WHERE st.id;
  IF v_ledger_mode IS NULL OR v_ledger_mode='off' THEN RETURN jsonb_build_object('outcome','ledger_off'); END IF;
  IF (SELECT count(*) FROM public.context_model_call_reservations WHERE run_date=v_date AND phase='ledger')>=v_ledger_calls
  THEN RETURN jsonb_build_object('outcome','ledger_budget','reason','ledger_calls_per_day','run_date',v_date,'limit',v_ledger_calls); END IF;
  SELECT count(*) INTO v_calls FROM public.context_model_call_reservations WHERE run_date=v_date;
  IF v_calls>=(v_pol->>'model_call_cap')::integer-v_reserve_day
  THEN RETURN jsonb_build_object('outcome','ledger_budget','reason','live_reserve','run_date',v_date,
   'ceiling',(v_pol->>'model_call_cap')::integer-v_reserve_day); END IF;
  IF (v_now AT TIME ZONE 'Australia/Perth')::time<(v_pol->>'morning_until')::time
   AND v_calls>=(v_pol->>'morning_cap')::integer-v_reserve_morning
  THEN RETURN jsonb_build_object('outcome','ledger_budget','reason','live_reserve_morning','run_date',v_date,
   'ceiling',(v_pol->>'morning_cap')::integer-v_reserve_morning); END IF;
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
REVOKE ALL ON FUNCTION public.reserve_context_model_call(text,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_context_model_call(text,uuid,uuid) TO service_role;
COMMENT ON FUNCTION public.reserve_context_model_call(text,uuid,uuid) IS
 'The one admission for every context model call: model_call_cap a Perth day (1000 since the call budget, 20261006060000; was 400). Attribution at most attribution_calls_day (300; was 60); both read from context_cadence_policy(). Vision within its share and daily cap (20261006001000); ledger (20261006013000) only while context_ledger_settings.mode is not off, under calls_per_day, and never inside its own live reserve (model_call_cap less context_ledger_settings.live_reserve_calls; before morning_until morning_cap less live_reserve_calls_morning), apart from the fact backlog''s context_cadence_settings. Outcomes reserved, paused, stale, cap, attribution_budget, vision_reserve, vision_budget, ledger_off, ledger_budget.';

-- 2. The reservations' phase list back to the ledger store's, NOT VALID around kept story calls.
DO $chk$
DECLARE c record;
BEGIN
 FOR c IN SELECT conname FROM pg_constraint
  WHERE conrelid = 'public.context_model_call_reservations'::regclass AND contype = 'c'
   AND pg_get_constraintdef(oid) = $d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'vision'::text, 'ledger'::text, 'story'::text])))$d$ LOOP
  EXECUTE format('ALTER TABLE public.context_model_call_reservations DROP CONSTRAINT %I', c.conname);
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_model_call_reservations'::regclass AND contype = 'c'
   AND pg_get_constraintdef(oid) IN ($d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'vision'::text, 'ledger'::text])))$d$,
    $d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'vision'::text, 'ledger'::text]))) NOT VALID$d$)) THEN
  IF EXISTS (SELECT 1 FROM public.context_model_call_reservations WHERE phase = 'story') THEN
   ALTER TABLE public.context_model_call_reservations ADD CONSTRAINT context_model_call_reservations_phase_check
    CHECK (phase IN ('attribution','extraction','bucket','vision','ledger')) NOT VALID;
  ELSE
   ALTER TABLE public.context_model_call_reservations ADD CONSTRAINT context_model_call_reservations_phase_check
    CHECK (phase IN ('attribution','extraction','bucket','vision','ledger'));
  END IF;
 END IF;
END $chk$;

-- 3. The writer's functions, then the tables (their checks read the shape helpers), then the helpers.
DROP FUNCTION IF EXISTS public.context_job_story_request_finish(uuid, uuid, text, text, timestamptz);
DROP FUNCTION IF EXISTS public.context_job_story_text_save(uuid, uuid, uuid, jsonb, text, timestamptz, uuid, text, text, jsonb);
DROP FUNCTION IF EXISTS public.context_job_story_writer_input(uuid);
DROP FUNCTION IF EXISTS public.context_job_story_claim(integer);
DROP FUNCTION IF EXISTS public.context_job_story_enqueue_changed(integer);
DROP FUNCTION IF EXISTS public.context_job_story_request(uuid, text, text);
DROP FUNCTION IF EXISTS public.context_job_story_text_get(uuid, jsonb, boolean);
DROP FUNCTION IF EXISTS public.context_job_story_budget();
DROP FUNCTION IF EXISTS public.context_job_story_claim_state(uuid);
DROP FUNCTION IF EXISTS public.context_job_story_record_sig(uuid);
DROP FUNCTION IF EXISTS public.context_job_story_reading(uuid);
DROP TABLE IF EXISTS public.context_job_story_texts;
DROP TABLE IF EXISTS public.context_job_story_requests;
DROP FUNCTION IF EXISTS public.context_job_story_card_hash(jsonb);
DROP FUNCTION IF EXISTS public.context_job_story_digest_at(jsonb);
DROP FUNCTION IF EXISTS public.context_job_story_digest_num(jsonb);
DROP FUNCTION IF EXISTS public.context_job_story_checks_problem(jsonb);
DROP FUNCTION IF EXISTS public.context_job_story_sections_problem(jsonb);
DROP FUNCTION IF EXISTS public.context_job_story_text_on();
DROP FUNCTION IF EXISTS public.context_job_story_text_policy();

-- 4. The switch row.
DELETE FROM public.feature_flags WHERE flag_name = 'context_job_story_text_v1';

-- 5. Proof in the same transaction.
DO $verify$
DECLARE live text;
BEGIN
 SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid = 'public.reserve_context_model_call(text,uuid,uuid)'::regprocedure;
 IF live IS DISTINCT FROM '0d741538d7874ce63d48e54d8645d18c' THEN
  RAISE EXCEPTION 'context_job_story_text_down_mismatch: reserve_context_model_call md5 %', live;
 END IF;
 IF to_regclass('public.context_job_story_texts') IS NOT NULL OR to_regclass('public.context_job_story_requests') IS NOT NULL THEN
  RAISE EXCEPTION 'context_job_story_text_down_mismatch: a story table is left';
 END IF;
END $verify$;
