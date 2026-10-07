-- Rollback of 20261006060000_context_call_budget_1000: the day's model call
-- budget back to 400 (300 before noon, 60 for attribution, vision while the
-- day is under 200).
--
-- Restores byte for byte, each md5 checked at the end:
--   reserve_context_model_call         28545c710b6234b76ba25eb09093fa39 (20261006013000)
--   context_ledger_budget              1584094b4240c206d05e12469e068c33 (20261006013000)
--   context_document_vision_policy     d56417f7977b5eb229417e2e03525a72 (20261006001000)
--   context_document_vision_admission  4366041d73165b1562c1af304a7534b3 (20261006001000)
--   context_core_status                e26a2d4387c9f642f473aa16caf4ab98 (20260924201000)
-- and the policy's three numbers (its live_since text is not touched, so its
-- masked md5 is K1's dba14be399cee7dd3e5165835bb623c6 again), the comments as
-- they were, and the four CHECKs back to 400. Each CHECK is validated when
-- every row fits; a reservation numbered past 400 (a day that used the larger
-- budget) or a ledger setting above 400 keeps it NOT VALID, so the existing
-- rows stay and no new row can pass it. No row is written or deleted.
-- Refuses unless each function is this migration's body or already the
-- pre-image (a second run changes nothing). The Luna worker's own ordinal
-- check (secureworks-jarvis CONTEXT_DAILY_RUN_CAP 1,000) is harmless under a
-- 400 cap and needs no rollback.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Guard: every body is this migration's or the pre-image; report all at once.
DO $guard$
DECLARE problems text[] := '{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.reserve_context_model_call(text,uuid,uuid)', ARRAY['0d741538d7874ce63d48e54d8645d18c','28545c710b6234b76ba25eb09093fa39']),
  ('public.context_ledger_budget()', ARRAY['8f7b42529db2e1062283de005cef01a7','1584094b4240c206d05e12469e068c33']),
  ('public.context_document_vision_policy()', ARRAY['160abaf805bacd50e6ee570385c67037','d56417f7977b5eb229417e2e03525a72']),
  ('public.context_document_vision_admission()', ARRAY['f1d33b0f0ee54516941ee313cb7fe756','4366041d73165b1562c1af304a7534b3']),
  ('public.context_core_status()', ARRAY['2b6b2c54daeae381cdeff7802d72df81','e26a2d4387c9f642f473aa16caf4ab98'])
 ) AS t(sig, accepted) LOOP
  live := NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS NULL OR NOT live = ANY(x.accepted) THEN
   problems := problems || format('%s md5 %s', x.sig, coalesce(live, '<missing>'));
  END IF;
 END LOOP;
 live := NULL;
 SELECT md5(regexp_replace(p.prosrc, '(''live_since'','')[^'']*('')', '\1<live_since>\2')) INTO live
 FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_cadence_policy()');
 IF live IS NULL OR live NOT IN ('69f9fb689b28d17679d45601e59f5b09', 'dba14be399cee7dd3e5165835bb623c6') THEN
  problems := problems || format('public.context_cadence_policy() masked md5 %s', coalesce(live, '<missing>'));
 END IF;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_call_budget_rollback_mismatch: %; a later migration replaced these, roll it back first',
   array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The policy: the three numbers back, live_since untouched.
DO $policy$
DECLARE src text;
 old_frag constant text := $o$'attribution_calls_day',60,'model_call_cap',400,'morning_cap',300,$o$;
 new_frag constant text := $n$'attribution_calls_day',300,'model_call_cap',1000,'morning_cap',750,$n$;
BEGIN
 SELECT p.prosrc INTO src FROM pg_proc p WHERE p.oid = 'public.context_cadence_policy()'::regprocedure;
 IF position(new_frag IN src) = 0 THEN RETURN; END IF;
 EXECUTE format('CREATE OR REPLACE FUNCTION public.context_cadence_policy() RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS %L',
  replace(src, new_frag, old_frag));
END $policy$;
COMMENT ON FUNCTION public.context_cadence_policy() IS
 'K1 cadence numbers (cadence.md 5.1) and live_since, the first apply time of 20260924030000. Rows captured before live_since never wake a read. Changed only by migration.';

-- 2. The bodies as they were (copied from the migrations that wrote them).
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
 SELECT coalesce(max(ordinal),0)+1 INTO v_ordinal FROM public.context_model_call_reservations WHERE run_date=v_date;
 IF v_ordinal>400 THEN RETURN jsonb_build_object('outcome','cap'); END IF;
 -- A1: attribution may use at most 60 of the day's 400 calls.
 IF p_phase='attribution' AND (SELECT count(*) FROM public.context_model_call_reservations
   WHERE run_date=v_date AND phase='attribution')>=60
 THEN RETURN jsonb_build_object('outcome','attribution_budget','run_date',v_date,'limit',60); END IF;
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
  v_pol := public.context_cadence_policy();
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
 'The one admission for every context model call (400 a Perth day). Attribution at most 60; vision within its share and daily cap (20261006001000); ledger (20261006013000) only while context_ledger_settings.mode is not off, under calls_per_day, and never inside its own live reserve (model_call_cap less context_ledger_settings.live_reserve_calls; before morning_until morning_cap less live_reserve_calls_morning), apart from the fact backlog''s context_cadence_settings. Outcomes reserved, paused, stale, cap, attribution_budget, vision_reserve, vision_budget, ledger_off, ledger_budget.';

CREATE OR REPLACE FUNCTION public.context_ledger_budget()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.context_ledger_settings; v_pol jsonb; v_now timestamptz := clock_timestamp(); v_local timestamp; v_date date;
 v_total integer; v_max integer; v_ledger integer; r_cap integer; r_day integer; r_live integer; r_morning integer;
 v_left integer; v_reason text; v_midnight timestamptz; v_resets timestamptz; v_window jsonb;
BEGIN
 v_local := v_now AT TIME ZONE 'Australia/Perth';
 v_date := v_local::date;
 v_midnight := (v_date + 1)::timestamp AT TIME ZONE 'Australia/Perth';
 SELECT * INTO s FROM public.context_ledger_settings WHERE id;
 -- the backfill hours: backfills and rebuilds wait outside them, updates never do
 v_window := jsonb_build_object('backfill_window', jsonb_build_object('from_hour', s.backfill_from_hour, 'to_hour', s.backfill_to_hour,
  'open', public.context_ledger_backfill_open(s.backfill_from_hour, s.backfill_to_hour, v_now)));
 -- The admission's own order: lane, the 400 cap, the switch, the ledger's
 -- daily ceiling, its live reserve all day, then before morning_until.
 IF NOT public.automation_lane_enabled('extraction') THEN
  RETURN jsonb_build_object('mode', coalesce(s.mode, 'off'), 'lane_on', false, 'calls_left', 0, 'reason', 'lane_off', 'resets_at', NULL) || v_window;
 END IF;
 v_pol := public.context_cadence_policy();
 SELECT count(*)::integer, coalesce(max(m.ordinal), 0)::integer, (count(*) FILTER (WHERE m.phase = 'ledger'))::integer
 INTO v_total, v_max, v_ledger FROM public.context_model_call_reservations m WHERE m.run_date = v_date;
 r_cap := 400 - v_max;
 IF r_cap <= 0 THEN
  RETURN jsonb_build_object('mode', coalesce(s.mode, 'off'), 'lane_on', true, 'calls_left', 0, 'reason', 'cap', 'resets_at', v_midnight) || v_window;
 END IF;
 IF s.id IS NULL OR s.mode = 'off' THEN
  RETURN jsonb_build_object('mode', 'off', 'lane_on', true, 'calls_left', 0, 'reason', 'ledger_off', 'resets_at', NULL) || v_window;
 END IF;
 r_day := s.calls_per_day - v_ledger;
 r_live := ((v_pol ->> 'model_call_cap')::integer - s.live_reserve_calls) - v_total;
 IF v_local::time < (v_pol ->> 'morning_until')::time THEN
  r_morning := ((v_pol ->> 'morning_cap')::integer - s.live_reserve_calls_morning) - v_total;
 END IF;
 v_left := greatest(0, least(r_cap, r_day, r_live, coalesce(r_morning, r_cap)));
 v_reason := CASE WHEN r_day <= 0 THEN 'ledger_calls_per_day' WHEN r_live <= 0 THEN 'live_reserve'
  WHEN r_morning <= 0 THEN 'live_reserve_morning' END;
 -- The line that binds resets with it: the morning line at morning_until,
 -- every other line at the next Perth midnight.
 v_resets := CASE WHEN r_morning IS NOT NULL AND r_morning <= least(r_cap, r_day, r_live)
  THEN (v_date + (v_pol ->> 'morning_until')::time) AT TIME ZONE 'Australia/Perth' ELSE v_midnight END;
 RETURN jsonb_build_object('mode', s.mode, 'lane_on', true, 'calls_left', v_left, 'reason', v_reason, 'resets_at', v_resets) || v_window;
END $$;
REVOKE ALL ON FUNCTION public.context_ledger_budget() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_budget() TO service_role;
COMMENT ON FUNCTION public.context_ledger_budget() IS
 'Context ledger store (20261006013000): the ledger''s budget now, as reserve_context_model_call''s ledger branch would answer: {mode, lane_on, calls_left, reason, resets_at}. calls_left is the smallest of what is left under the 400 cap, the ledger''s calls_per_day, its own live reserve line (model_call_cap less live_reserve_calls) and, before morning_until, its morning line (morning_cap less live_reserve_calls_morning). reason, when nothing is left, in the admission''s order: lane_off, cap, ledger_off, ledger_calls_per_day, live_reserve, live_reserve_morning; null while calls are left. resets_at: morning_until when the morning line binds, else the next Perth midnight; null when switched off. backfill_window: {from_hour, to_hour, open} (Perth; both null = any time): backfills and rebuilds wait outside it, updates never do. Service role only.';

CREATE OR REPLACE FUNCTION public.context_document_vision_policy() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
  'flag','context_document_vision_v1',
  'phase','vision',
  'event_source','context-document-vision',
  -- The same kind of evidence row, in the same dedupe space, as B-5.
  'event_type','document.text_extracted',
  'key_prefix','doctext:',
  -- Documents looked at per "next" call before one is handed out.
  'batch_limit',5,
  -- Documents read per Perth day: the default, and the most the desk may set.
  'daily_cap_default',100,
  'daily_cap_max',300,
  -- A vision call is admitted only while fewer than this many of the day's
  -- 400 shared model calls are used; the rest stay for the job reads.
  'shared_calls_ceiling',200,
  -- What one call may carry: a photo up to 5 MB; a scanned PDF up to 5 MB,
  -- of which at most 5 page images (each at least 300 px on its short side).
  'max_image_bytes',5000000,
  'max_pdf_bytes',5000000,
  'max_images',5,
  'min_image_side',300,
  -- The words kept: at most 40,000 characters, at least 3, and only when the
  -- model is at least 0.5 confident.
  'max_chars',40000,
  'min_chars',3,
  'min_confidence',0.5,
  -- A claimed document is the worker's for 30 minutes.
  'lease_minutes',30,
  -- Waits after an error; the attempt after the last wait that fails again is terminal.
  'backoff_minutes',jsonb_build_array(60,360,1440),
  -- A document from the last 48 hours wakes a read; an older one is history.
  'live_window_hours',48,
  'catchup_priority',2,
  -- Alarms.
  'stale_hours',6,
  'failing_min_attempts',5,
  'failing_error_ratio',0.3)
$$;

CREATE OR REPLACE FUNCTION public.context_document_vision_admission() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 policy jsonb:=public.context_document_vision_policy();
 today date:=(clock_timestamp() AT TIME ZONE 'Australia/Perth')::date;
 used integer; vision_used integer; cap integer:=public.context_document_vision_daily_cap();
 ceiling integer:=(policy->>'shared_calls_ceiling')::integer; why text;
BEGIN
 SELECT count(*), count(*) FILTER (WHERE r.phase='vision') INTO used, vision_used
 FROM public.context_model_call_reservations r WHERE r.run_date=today;
 why:=CASE
  WHEN NOT (public.context_document_vision_flag()->>'enabled')::boolean THEN 'flag_off'
  WHEN NOT public.automation_lane_enabled('capture') OR NOT public.automation_lane_enabled('extraction') THEN 'paused'
  WHEN used>=400 THEN 'cap'
  WHEN used>=ceiling THEN 'vision_reserve'
  WHEN vision_used>=cap THEN 'vision_budget'
 END;
 RETURN jsonb_build_object('open',why IS NULL,'code',why,'run_date',today,'calls_used_today',used,'vision_calls_today',vision_used,
  'vision_daily_cap',cap,'shared_calls_ceiling',ceiling);
END $$;
REVOKE ALL ON FUNCTION public.context_document_vision_policy(), public.context_document_vision_admission() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_document_vision_policy(), public.context_document_vision_admission() TO service_role;

CREATE OR REPLACE FUNCTION public.context_core_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d date:=(now() AT TIME ZONE 'Australia/Perth')::date; switches jsonb; queue jsonb; calls integer; call_state text:='available'; ready integer;
BEGIN
 SELECT to_jsonb(s) INTO switches FROM public.automation_switches s WHERE id=1;
 SELECT jsonb_object_agg(status,n) INTO queue FROM (SELECT coalesce(e.attribution_status,'unknown') status,count(*) n
 FROM public.business_events e WHERE e.attribution_status NOT IN ('empty','automated')
 AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r WHERE r.event_id=e.id AND r.job_id=e.job_id AND r.extractor_version='luna_v2')
 GROUP BY e.attribution_status) q;
 BEGIN
  EXECUTE 'SELECT count(*) FROM public.context_model_call_reservations WHERE run_date=$1' INTO calls USING d;
 EXCEPTION WHEN OTHERS THEN calls:=NULL;call_state:='unavailable'; END;
 ready:=public.context_ready_jobs_count(400);
 RETURN jsonb_build_object('as_of',now(),'run_date',d,'switches',switches,
  'lanes',jsonb_build_object('capture',public.automation_lane_enabled('capture'),'attribution',public.automation_lane_enabled('attribution'),'extraction',public.automation_lane_enabled('extraction')),
  'runs_used',(SELECT count(*) FROM public.context_extraction_runs WHERE run_date=d AND phase='extraction'),'run_cap',400,
  'runs_by_status',(SELECT coalesce(jsonb_object_agg(status,n),'{}'::jsonb) FROM (SELECT status,count(*) n FROM public.context_extraction_runs WHERE run_date=d AND phase='extraction' GROUP BY status) s),
  'failed_by_error',(SELECT coalesce(jsonb_object_agg(coalesce(nullif(error,''),'(none)'),n),'{}'::jsonb) FROM (SELECT error,count(*) n FROM public.context_extraction_runs WHERE run_date=d AND phase='extraction' AND status='failed' GROUP BY error) s),
  'model_calls_used',calls,'model_call_cap',400,'model_call_budget_state',call_state,
  'evidence_by_attribution_status',coalesce(queue,'{}'::jsonb),'ready_jobs',ready,'ready_jobs_is_lower_bound',ready=400,
  'admin_bucket_size',(SELECT count(*) FROM public.business_events WHERE attribution_status='admin_bucket'),
  'missing_event_time',(SELECT count(*) FROM public.business_events WHERE event_at IS NULL AND occurred_at IS NULL AND attribution_status NOT IN ('empty','automated')),
  'oldest_pending_event_at',(SELECT min(coalesce(e.event_at, e.occurred_at)) FROM public.business_events e WHERE e.attribution_status NOT IN ('empty','automated') AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r WHERE r.event_id=e.id AND r.job_id=e.job_id AND r.extractor_version='luna_v2')),
  'last_pass_finished_at',(SELECT max(finished_at) FROM public.context_pass_days WHERE status='done'),
  'today_pass',(SELECT to_jsonb(p) FROM public.context_pass_days p WHERE run_date=d),
  'coverage',public.context_coverage(),
  'actor_missing',public.context_actor_missing_status());
END $$;
REVOKE ALL ON FUNCTION public.context_core_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_core_status() TO service_role;
COMMENT ON FUNCTION public.context_core_status() IS
 'Status block core: the 17 Sep heartbeat body, unchanged, plus actor_missing (F-ACT). Its keys are the top-level keys of context_pipeline_status(). Owned by the foundation track (F1, F-ACT).';

-- 3. The ledger settings' words as they were.
COMMENT ON TABLE public.context_ledger_settings IS
 'Context ledger: the ledger lane''s switch (20261006010000). mode off = no reads; shadow = read jobs into shadow generations nobody is shown; live = promote passing generations and keep them current. calls_per_day is the lane''s own ceiling inside the shared 400 model calls a Perth day; the live reserve still applies. live_reserve_calls and live_reserve_calls_morning are the calls the ledger always leaves free for live fact reads (its own line, apart from the fact backlog''s context_cadence_settings). job_ids limits which jobs are read (NULL = every live job). One row; seeded off with 0 calls, a 100-call reserve both ways and no list. Service role only.';
COMMENT ON COLUMN public.context_ledger_settings.live_reserve_calls IS
 'Context ledger: calls the ledger always leaves free for live fact reads, all day (20261006010000). The ledger stops at model_call_cap less this, whatever the fact backlog''s own reserve (context_cadence_settings) is. 50 to 400 (never below 50); default 100.';
COMMENT ON COLUMN public.context_ledger_settings.live_reserve_calls_morning IS
 'Context ledger: calls the ledger always leaves free for live fact reads before morning_until (20261006010000). Before then the ledger also stops at morning_cap less this. 50 to 400 (never below 50); default 100.';

-- 4. The CHECKs back to 400: validated where every row fits, else NOT VALID.
DO $chk$
DECLARE c record; x record; n bigint;
BEGIN
 FOR c IN SELECT conname FROM pg_constraint
  WHERE conrelid = 'public.context_model_call_reservations'::regclass AND contype = 'c'
   AND pg_get_constraintdef(oid) = 'CHECK (((ordinal >= 1) AND (ordinal <= 1000)))' LOOP
  EXECUTE format('ALTER TABLE public.context_model_call_reservations DROP CONSTRAINT %I', c.conname);
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_model_call_reservations'::regclass AND contype = 'c'
   AND pg_get_constraintdef(oid) IN ('CHECK (((ordinal >= 1) AND (ordinal <= 400)))', 'CHECK (((ordinal >= 1) AND (ordinal <= 400))) NOT VALID')) THEN
  ALTER TABLE public.context_model_call_reservations ADD CONSTRAINT context_model_call_reservations_ordinal_check
   CHECK (ordinal BETWEEN 1 AND 400) NOT VALID;
  BEGIN
   ALTER TABLE public.context_model_call_reservations VALIDATE CONSTRAINT context_model_call_reservations_ordinal_check;
  EXCEPTION WHEN check_violation THEN
   SELECT count(*) INTO n FROM public.context_model_call_reservations WHERE ordinal > 400;
   RAISE NOTICE 'context_model_call_reservations_ordinal_check kept NOT VALID: % reservations are numbered past 400', n;
  END;
 END IF;
 FOR x IN SELECT * FROM (VALUES ('calls_per_day', 0), ('live_reserve_calls', 50), ('live_reserve_calls_morning', 50)) AS t(col, low) LOOP
  FOR c IN SELECT conname FROM pg_constraint
   WHERE conrelid = 'public.context_ledger_settings'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) = format('CHECK (((%1$s >= %2$s) AND (%1$s <= 1000)))', x.col, x.low) LOOP
   EXECUTE format('ALTER TABLE public.context_ledger_settings DROP CONSTRAINT %I', c.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_ledger_settings'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) IN (format('CHECK (((%1$s >= %2$s) AND (%1$s <= 400)))', x.col, x.low),
     format('CHECK (((%1$s >= %2$s) AND (%1$s <= 400))) NOT VALID', x.col, x.low))) THEN
   EXECUTE format('ALTER TABLE public.context_ledger_settings ADD CONSTRAINT %I CHECK (%I BETWEEN %s AND 400) NOT VALID',
    'context_ledger_settings_' || x.col || '_check', x.col, x.low);
   BEGIN
    EXECUTE format('ALTER TABLE public.context_ledger_settings VALIDATE CONSTRAINT %I', 'context_ledger_settings_' || x.col || '_check');
   EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'context_ledger_settings_%_check kept NOT VALID: the settings row is above 400', x.col;
   END;
  END IF;
 END LOOP;
END $chk$;

-- 5. Proof: every body is the pre-image again and the policy answers K1's numbers.
DO $verify$
DECLARE x record; live text; pol jsonb := public.context_cadence_policy();
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.reserve_context_model_call(text,uuid,uuid)', '28545c710b6234b76ba25eb09093fa39'),
  ('public.context_ledger_budget()', '1584094b4240c206d05e12469e068c33'),
  ('public.context_document_vision_policy()', 'd56417f7977b5eb229417e2e03525a72'),
  ('public.context_document_vision_admission()', '4366041d73165b1562c1af304a7534b3'),
  ('public.context_core_status()', 'e26a2d4387c9f642f473aa16caf4ab98')) AS t(sig, md5) LOOP
  SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid = to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.md5 THEN RAISE EXCEPTION 'context_call_budget rollback: % not restored (md5 %)', x.sig, live; END IF;
 END LOOP;
 SELECT md5(regexp_replace(prosrc, '(''live_since'','')[^'']*('')', '\1<live_since>\2')) INTO live
 FROM pg_proc WHERE oid = 'public.context_cadence_policy()'::regprocedure;
 IF live IS DISTINCT FROM 'dba14be399cee7dd3e5165835bb623c6' OR (pol ->> 'model_call_cap')::integer <> 400
  OR (pol ->> 'morning_cap')::integer <> 300 OR (pol ->> 'attribution_calls_day')::integer <> 60 THEN
  RAISE EXCEPTION 'context_call_budget rollback: policy not restored %', pol;
 END IF;
END $verify$;
