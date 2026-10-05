-- Rollback of 20261006013000_context_ledger_store: the ledger store is
-- removed and the model call admission goes back to the 20261006001000 body.
-- Ledger reservations and ledger runs are deleted (they only ever held ledger
-- reads; the day's other calls are untouched), building generations are
-- marked failed, and the generations keep their rows with no run. The ledger
-- tables themselves (20261006010000) and every item and transition stay.
-- Refuses when a later migration has already replaced the admission, and
-- while the job story (20261006014000) is installed: the story reads the
-- store's evidence definition, so roll the story back first.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE live text;
BEGIN
 SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid = to_regprocedure('public.reserve_context_model_call(text,uuid,uuid)');
 IF live IS NULL OR live NOT IN ('28545c710b6234b76ba25eb09093fa39', 'f50de57b906f28fc9b5b286821d64cb1') THEN
  RAISE EXCEPTION 'context_ledger_store_down_refused: reserve_context_model_call md5 % is a later body; roll that back first', coalesce(live, '<missing>');
 END IF;
 IF to_regprocedure('public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)') IS NOT NULL THEN
  RAISE EXCEPTION 'context_ledger_store_down_refused: roll back 20261006014000_context_job_story first';
 END IF;
END $guard$;

-- Ledger calls and runs leave the shared ledgers first, so the phase lists can narrow.
DELETE FROM public.context_model_call_reservations WHERE phase = 'ledger';
UPDATE public.context_ledger_generations SET status = 'failed', failure = 'ledger_store_rolled_back', finished_at = coalesce(finished_at, now()),
 updated_at = now() WHERE status = 'building';
UPDATE public.context_ledger_generations SET run_id = NULL
 WHERE run_id IN (SELECT id FROM public.context_extraction_runs WHERE phase = 'ledger');
DROP TABLE IF EXISTS public.context_ledger_writes;
DELETE FROM public.context_extraction_runs WHERE phase = 'ledger';

CREATE OR REPLACE FUNCTION public.reserve_context_model_call(p_phase text,p_run_id uuid,p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_now timestamptz; v_date date; v_ordinal integer; v_id uuid; r public.context_extraction_runs;
BEGIN
 IF p_phase IS NULL OR p_phase NOT IN ('attribution','extraction','bucket','vision')
 OR (p_run_id IS NULL) <> (p_lease_token IS NULL)
 OR (p_phase='extraction' AND p_run_id IS NULL)
 OR (p_phase='vision' AND p_run_id IS NOT NULL) THEN
  RAISE EXCEPTION 'Invalid model call identity';
 END IF;
 PERFORM pg_advisory_xact_lock(20260911,1);
 IF NOT public.automation_lane_enabled(CASE WHEN p_phase IN ('extraction','vision') THEN 'extraction' ELSE 'attribution' END)
 OR (p_phase='vision' AND NOT public.automation_lane_enabled('capture'))
 THEN RETURN jsonb_build_object('outcome','paused'); END IF;
 PERFORM 1 FROM public.automation_switches WHERE id=1 FOR SHARE;
 IF NOT public.automation_lane_enabled(CASE WHEN p_phase IN ('extraction','vision') THEN 'extraction' ELSE 'attribution' END)
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

DO $chk$
DECLARE c record;
BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.context_extraction_runs'::regclass AND contype = 'c'
  AND pg_get_constraintdef(oid) = $d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'ledger'::text])))$d$ LOOP
  EXECUTE format('ALTER TABLE public.context_extraction_runs DROP CONSTRAINT %I', c.conname);
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_extraction_runs'::regclass AND contype = 'c'
   AND pg_get_constraintdef(oid) = $d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text])))$d$) THEN
  ALTER TABLE public.context_extraction_runs ADD CONSTRAINT context_extraction_runs_phase_check
   CHECK (phase IN ('attribution','extraction','bucket'));
 END IF;
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.context_model_call_reservations'::regclass AND contype = 'c'
  AND pg_get_constraintdef(oid) = $d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'vision'::text, 'ledger'::text])))$d$ LOOP
  EXECUTE format('ALTER TABLE public.context_model_call_reservations DROP CONSTRAINT %I', c.conname);
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_model_call_reservations'::regclass AND contype = 'c'
   AND pg_get_constraintdef(oid) = $d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'vision'::text])))$d$) THEN
  ALTER TABLE public.context_model_call_reservations ADD CONSTRAINT context_model_call_reservations_phase_check
   CHECK (phase IN ('attribution','extraction','bucket','vision'));
 END IF;
END $chk$;

DROP FUNCTION IF EXISTS public.context_ledger_promote_shadow(text,uuid[],integer);
DROP FUNCTION IF EXISTS public.context_ledger_person_edit(uuid,uuid,text,text,text,jsonb);
DROP FUNCTION IF EXISTS public.context_ledger_finish(uuid,uuid,uuid,text,jsonb);
DROP FUNCTION IF EXISTS public.context_ledger_promote(uuid,text);
DROP FUNCTION IF EXISTS public.context_ledger_checks_pass(jsonb);
DROP FUNCTION IF EXISTS public.context_ledger_carry_forward(uuid,uuid);
DROP FUNCTION IF EXISTS public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text);
DROP FUNCTION IF EXISTS public.context_ledger_check_item(uuid,jsonb,text,uuid,text);
DROP FUNCTION IF EXISTS public.context_ledger_cite(uuid,jsonb);
DROP FUNCTION IF EXISTS public.context_ledger_packet(uuid,timestamptz,timestamptz);
DROP FUNCTION IF EXISTS public.context_ledger_claim(uuid,text,date);
DROP FUNCTION IF EXISTS public.context_ledger_due(integer);
DROP FUNCTION IF EXISTS public.context_ledger_judge(uuid[]);
DROP FUNCTION IF EXISTS public.context_ledger_failures(uuid[]);
DROP FUNCTION IF EXISTS public.context_ledger_budget();
DROP FUNCTION IF EXISTS public.context_ledger_backfill_open(smallint, smallint, timestamptz);
DROP FUNCTION IF EXISTS public.context_ledger_current_generation(uuid);
DROP FUNCTION IF EXISTS public.context_ledger_evidence_rows(uuid[],timestamptz);
DROP FUNCTION IF EXISTS public.context_ledger_row_admissible(public.business_events);
DROP FUNCTION IF EXISTS public.context_ledger_message_kind(public.business_events);
DROP FUNCTION IF EXISTS public.context_ledger_text_norm(text);
