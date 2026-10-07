-- The day's AI call budget: 1,000 model calls a Perth day (owner ruling,
-- 6 Oct 2026, about 1:30 pm Perth).
--
-- Why. Every model call the context system makes (job fact reads, AI
-- placement of messages onto jobs, the ledger reader, document vision) takes
-- one reservation from one shared daily budget, reserve_context_model_call.
-- At 400 a day the reads stopped well before the day's work was done (5 Oct:
-- 397 calls; 6 Oct: 307 by 1:30 pm, placement's 60 spent by 12:38 am, and
-- the ledger held at its live reserve line). The owner ruled: 1,000 calls a
-- day, 300 of them for placement.
--
-- What changes (numbers only; every rule stays as it was):
--   model_call_cap          400 -> 1,000  the hard cap, every phase
--   morning_cap             300 ->   750  calls before 12:00 Perth (job reads
--                                        pause at it until noon)
--   attribution_calls_day    60 ->   300  AI placement's own share
--   vision ceiling           200 ->   500  a vision call only while the day's
--                                        calls are under it
-- Unchanged: the live reserves (context_cadence_settings: 100 all day, 100
-- before noon, 2 reads a job; context_ledger_settings: 100 and 100), every
-- other cadence number (quiet 15, ceiling 60, cooldown 30, 6 runs a job a day
-- plus 4 for a customer in business hours, retries, tick, leases, breach 90),
-- live_since, the vision daily cap (100, at most 300), the ledger's own
-- settings values and every flag and switch. The lines the reserves keep
-- become: the fact backlog and the ledger stop at 900 calls (650 before
-- noon); live reads go on to 1,000 (750 before noon); vision stops at 500.
--
-- Where the old numbers lived, and what now reads them:
--  1. context_cadence_policy(): model_call_cap, morning_cap and
--     attribution_calls_day. The body is K1's, byte for byte, with only those
--     three numbers changed; live_since keeps its exact text. Already read
--     from here (unchanged): context_jobs_cadence (model_cap,
--     pacing_reserve, the backlog ceiling), context_cadence_status
--     (cadence_breach, read_reserve), claim_context_extraction_run, and the
--     ledger's live reserve lines.
--  2. reserve_context_model_call(text,uuid,uuid): hard-coded 400 (the cap)
--     and 60 (attribution). It now reads both from the policy, so the policy
--     is the one place they live. Every other branch is unchanged.
--  3. context_ledger_budget(): hard-coded 400 in the cap line; now the
--     policy's model_call_cap.
--  4. context_document_vision_policy(): shared_calls_ceiling 200 -> 500.
--  5. context_document_vision_admission(): hard-coded 400 (code cap); now the
--     policy's model_call_cap.
--  6. context_core_status(): the heartbeat's model_call_cap and run_cap were
--     a hard-coded 400 (the worker's morning line prints "N of cap model
--     calls used"); both now read the policy's model_call_cap. Every other
--     heartbeat key is unchanged.
--  7. CHECK constraints: context_model_call_reservations.ordinal 1 to 400
--     (call 401 would fail its insert) -> 1 to 1,000; context_ledger_settings
--     calls_per_day 0 to 400 -> 0 to 1,000, live_reserve_calls and
--     live_reserve_calls_morning 50 to 400 -> 50 to 1,000 (the ledger's own
--     lines stay inside the day's cap). No row is written.
-- Not a call budget, unchanged: context_extraction_candidates and
-- context_ready_jobs_count list at most 400 due jobs (a list size; the worker
-- takes 10 a tick and asks again every tick).
--
-- The worker. The Luna context worker (secureworks-jarvis) refuses a
-- reservation numbered above its own CONTEXT_DAILY_RUN_CAP (400 before its
-- call budget PR). Deploy that worker change first: with it live and this
-- migration not, nothing changes (no reservation passes 400); with this
-- migration live and the old worker, call 401 is reserved and then refused
-- by the worker (invalid_model_reservation) every few minutes.
--
-- Built on the LIVE production definitions, read read-only on 6 Oct 2026:
--   reserve_context_model_call       md5 28545c710b6234b76ba25eb09093fa39 (20261006013000)
--   context_ledger_budget            md5 1584094b4240c206d05e12469e068c33 (20261006013000)
--   context_document_vision_policy   md5 d56417f7977b5eb229417e2e03525a72 (20261006001000)
--   context_document_vision_admission md5 4366041d73165b1562c1af304a7534b3 (20261006001000)
--   context_core_status              md5 e26a2d4387c9f642f473aa16caf4ab98 (20260924201000)
--   context_cadence_policy           md5 dbdd66031c54836d4678d714a9f5b078 (20260924030000;
--     with its live_since text masked, dba14be399cee7dd3e5165835bb623c6,
--     which is what the guard checks, because live_since is the first apply
--     time and differs in every database)
--   the four CHECKs above as written by 20260911170001 and 20261006010000.
-- The guard refuses unless each is that pre-image or already this
-- migration's result (a re-apply), and reports every mismatch at once.
--
-- Rollback: supabase/rollbacks/20261006060000_context_call_budget_1000_down.sql
-- (every body back byte for byte, the policy's three numbers back, the
-- CHECKs back to 400, kept NOT VALID only where rows already pass 400).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[] := '{}'; live text; x record; chk text;
BEGIN
 -- Replaced functions: the live production body, or this migration's (re-apply).
 FOR x IN SELECT * FROM (VALUES
  ('public.reserve_context_model_call(text,uuid,uuid)', ARRAY['28545c710b6234b76ba25eb09093fa39','0d741538d7874ce63d48e54d8645d18c']),
  ('public.context_ledger_budget()', ARRAY['1584094b4240c206d05e12469e068c33','8f7b42529db2e1062283de005cef01a7']),
  ('public.context_document_vision_policy()', ARRAY['d56417f7977b5eb229417e2e03525a72','160abaf805bacd50e6ee570385c67037']),
  ('public.context_document_vision_admission()', ARRAY['4366041d73165b1562c1af304a7534b3','f1d33b0f0ee54516941ee313cb7fe756']),
  ('public.context_core_status()', ARRAY['e26a2d4387c9f642f473aa16caf4ab98','2b6b2c54daeae381cdeff7802d72df81'])
 ) AS t(sig, accepted) LOOP
  live := NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS NULL OR NOT live = ANY(x.accepted) THEN
   problems := problems || format('%s md5 %s', x.sig, coalesce(live, '<missing>'));
  END IF;
 END LOOP;
 -- The policy carries its first apply time (live_since), so its body is
 -- compared with that text masked: K1's body, or this migration's.
 live := NULL;
 SELECT md5(regexp_replace(p.prosrc, '(''live_since'','')[^'']*('')', '\1<live_since>\2')) INTO live
 FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_cadence_policy()');
 IF live IS NULL OR live NOT IN ('dba14be399cee7dd3e5165835bb623c6', '69f9fb689b28d17679d45601e59f5b09') THEN
  problems := problems || format('public.context_cadence_policy() masked md5 %s', coalesce(live, '<missing>'));
 END IF;
 -- Readers of the policy this migration relies on and does not replace.
 FOR x IN SELECT * FROM (VALUES ('public.context_jobs_cadence(uuid[])'), ('public.context_cadence_status()'),
   ('public.claim_context_extraction_run(uuid,date,text)'), ('public.context_document_vision_daily_cap()'),
   ('public.automation_lane_enabled(text)'), ('public.context_actor_missing_status()')) AS t(sig) LOOP
  IF to_regprocedure(x.sig) IS NULL THEN problems := problems || format('%s missing', x.sig); END IF;
 END LOOP;
 -- The CHECKs: as written (400), narrowed NOT VALID by this migration's
 -- rollback, or already this migration's (1,000).
 SELECT string_agg(pg_get_constraintdef(c.oid), ' | ') INTO chk FROM pg_constraint c
 WHERE c.conrelid = to_regclass('public.context_model_call_reservations') AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%ordinal%';
 IF chk IS NULL OR chk NOT IN ('CHECK (((ordinal >= 1) AND (ordinal <= 400)))', 'CHECK (((ordinal >= 1) AND (ordinal <= 400))) NOT VALID',
   'CHECK (((ordinal >= 1) AND (ordinal <= 1000)))') THEN
  problems := problems || format('context_model_call_reservations ordinal check is %s', coalesce(chk, '<missing>'));
 END IF;
 FOR x IN SELECT * FROM (VALUES ('calls_per_day', 0), ('live_reserve_calls', 50), ('live_reserve_calls_morning', 50)) AS t(col, low) LOOP
  chk := NULL;
  SELECT string_agg(pg_get_constraintdef(c.oid), ' | ') INTO chk FROM pg_constraint c
  WHERE c.conrelid = to_regclass('public.context_ledger_settings') AND c.contype = 'c'
   AND pg_get_constraintdef(c.oid) LIKE format('%%((%s >= %s) AND%%', x.col, x.low);
  IF chk IS NULL OR chk NOT IN (format('CHECK (((%1$s >= %2$s) AND (%1$s <= 400)))', x.col, x.low),
    format('CHECK (((%1$s >= %2$s) AND (%1$s <= 400))) NOT VALID', x.col, x.low),
    format('CHECK (((%1$s >= %2$s) AND (%1$s <= 1000)))', x.col, x.low)) THEN
   problems := problems || format('context_ledger_settings %s check is %s', x.col, coalesce(chk, '<missing>'));
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_call_budget_preimage_mismatch: %; read the live definitions before replacing them',
   array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The CHECKs widen first, so the new cap never meets the old bound. Only
-- the expected definitions are dropped; nothing else on either table moves.
DO $chk$
DECLARE c record; x record;
BEGIN
 FOR c IN SELECT conname FROM pg_constraint
  WHERE conrelid = 'public.context_model_call_reservations'::regclass AND contype = 'c'
   AND pg_get_constraintdef(oid) IN ('CHECK (((ordinal >= 1) AND (ordinal <= 400)))', 'CHECK (((ordinal >= 1) AND (ordinal <= 400))) NOT VALID') LOOP
  EXECUTE format('ALTER TABLE public.context_model_call_reservations DROP CONSTRAINT %I', c.conname);
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_model_call_reservations'::regclass AND contype = 'c'
   AND pg_get_constraintdef(oid) = 'CHECK (((ordinal >= 1) AND (ordinal <= 1000)))') THEN
  ALTER TABLE public.context_model_call_reservations ADD CONSTRAINT context_model_call_reservations_ordinal_check
   CHECK (ordinal BETWEEN 1 AND 1000);
 END IF;
 FOR x IN SELECT * FROM (VALUES ('calls_per_day', 0), ('live_reserve_calls', 50), ('live_reserve_calls_morning', 50)) AS t(col, low) LOOP
  FOR c IN SELECT conname FROM pg_constraint
   WHERE conrelid = 'public.context_ledger_settings'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) IN (format('CHECK (((%1$s >= %2$s) AND (%1$s <= 400)))', x.col, x.low),
     format('CHECK (((%1$s >= %2$s) AND (%1$s <= 400))) NOT VALID', x.col, x.low)) LOOP
   EXECUTE format('ALTER TABLE public.context_ledger_settings DROP CONSTRAINT %I', c.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_ledger_settings'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) = format('CHECK (((%1$s >= %2$s) AND (%1$s <= 1000)))', x.col, x.low)) THEN
   EXECUTE format('ALTER TABLE public.context_ledger_settings ADD CONSTRAINT %I CHECK (%I BETWEEN %s AND 1000)',
    'context_ledger_settings_' || x.col || '_check', x.col, x.low);
  END IF;
 END LOOP;
END $chk$;

-- 2. The policy: K1's body with only the three numbers changed. live_since
-- is not re-rendered: the replacement works on the live text, so the first
-- apply time stays exactly what it was.
DO $policy$
DECLARE src text;
 old_frag constant text := $o$'attribution_calls_day',60,'model_call_cap',400,'morning_cap',300,$o$;
 new_frag constant text := $n$'attribution_calls_day',300,'model_call_cap',1000,'morning_cap',750,$n$;
BEGIN
 SELECT p.prosrc INTO src FROM pg_proc p WHERE p.oid = 'public.context_cadence_policy()'::regprocedure;
 IF position(new_frag IN src) > 0 THEN RETURN; END IF;
 IF (length(src) - length(replace(src, old_frag, ''))) / length(old_frag) <> 1 THEN
  RAISE EXCEPTION 'context_call_budget_policy_unexpected: the K1 numbers are not in the policy exactly once';
 END IF;
 EXECUTE format('CREATE OR REPLACE FUNCTION public.context_cadence_policy() RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS %L',
  replace(src, old_frag, new_frag));
END $policy$;
COMMENT ON FUNCTION public.context_cadence_policy() IS
 'K1 cadence numbers (cadence.md 5.1) and live_since, the first apply time of 20260924030000. Rows captured before live_since never wake a read. Changed only by migration. Call budget (20261006060000, owner ruling 6 Oct 2026): model_call_cap 1000, morning_cap 750, attribution_calls_day 300 (were 400, 300, 60); reserve_context_model_call, context_ledger_budget, the vision admission and the heartbeat read them here.';

-- 3. The admission: the 20261006013000 body with the cap and attribution's
-- share read from the policy (marked "call budget"). Every branch, outcome and
-- order is otherwise unchanged.
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

-- 4. The ledger's budget read: its cap line is the policy's, as the admission's is.
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
 -- The admission's own order: lane, the day's cap (model_call_cap), the
 -- switch, the ledger's daily ceiling, its live reserve all day, then before
 -- morning_until.
 IF NOT public.automation_lane_enabled('extraction') THEN
  RETURN jsonb_build_object('mode', coalesce(s.mode, 'off'), 'lane_on', false, 'calls_left', 0, 'reason', 'lane_off', 'resets_at', NULL) || v_window;
 END IF;
 v_pol := public.context_cadence_policy();
 SELECT count(*)::integer, coalesce(max(m.ordinal), 0)::integer, (count(*) FILTER (WHERE m.phase = 'ledger'))::integer
 INTO v_total, v_max, v_ledger FROM public.context_model_call_reservations m WHERE m.run_date = v_date;
 r_cap := (v_pol ->> 'model_call_cap')::integer - v_max;
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
 'Context ledger store (20261006013000): the ledger''s budget now, as reserve_context_model_call''s ledger branch would answer: {mode, lane_on, calls_left, reason, resets_at}. calls_left is the smallest of what is left under the day''s cap (context_cadence_policy model_call_cap, 1000 since the call budget 20261006060000), the ledger''s calls_per_day, its own live reserve line (model_call_cap less live_reserve_calls) and, before morning_until, its morning line (morning_cap less live_reserve_calls_morning). reason, when nothing is left, in the admission''s order: lane_off, cap, ledger_off, ledger_calls_per_day, live_reserve, live_reserve_morning; null while calls are left. resets_at: morning_until when the morning line binds, else the next Perth midnight; null when switched off. backfill_window: {from_hour, to_hour, open} (Perth; both null = any time): backfills and rebuilds wait outside it, updates never do. Service role only.';

-- 5. Vision: a call only while the day's calls are under 500.
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
  -- shared model calls are used; the rest stay for the job reads (owner
  -- ruling 6 Oct 2026: 500 of the 1,000; call budget 20261006060000).
  'shared_calls_ceiling',500,
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

-- 6. The vision admission read: its cap line is the policy's.
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
  WHEN used>=(public.context_cadence_policy()->>'model_call_cap')::integer THEN 'cap'
  WHEN used>=ceiling THEN 'vision_reserve'
  WHEN vision_used>=cap THEN 'vision_budget'
 END;
 RETURN jsonb_build_object('open',why IS NULL,'code',why,'run_date',today,'calls_used_today',used,'vision_calls_today',vision_used,
  'vision_daily_cap',cap,'shared_calls_ceiling',ceiling);
END $$;
REVOKE ALL ON FUNCTION public.context_document_vision_policy(), public.context_document_vision_admission() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_document_vision_policy(), public.context_document_vision_admission() TO service_role;

-- 7. The heartbeat core: model_call_cap and run_cap are the policy's cap.
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
  'runs_used',(SELECT count(*) FROM public.context_extraction_runs WHERE run_date=d AND phase='extraction'),'run_cap',(public.context_cadence_policy()->>'model_call_cap')::integer,
  'runs_by_status',(SELECT coalesce(jsonb_object_agg(status,n),'{}'::jsonb) FROM (SELECT status,count(*) n FROM public.context_extraction_runs WHERE run_date=d AND phase='extraction' GROUP BY status) s),
  'failed_by_error',(SELECT coalesce(jsonb_object_agg(coalesce(nullif(error,''),'(none)'),n),'{}'::jsonb) FROM (SELECT error,count(*) n FROM public.context_extraction_runs WHERE run_date=d AND phase='extraction' AND status='failed' GROUP BY error) s),
  'model_calls_used',calls,'model_call_cap',(public.context_cadence_policy()->>'model_call_cap')::integer,'model_call_budget_state',call_state,
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
 'Status block core: the 17 Sep heartbeat body, unchanged, plus actor_missing (F-ACT). Since the call budget (20261006060000) model_call_cap and run_cap are context_cadence_policy()''s model_call_cap (1000; were a fixed 400). Its keys are the top-level keys of context_pipeline_status(). Owned by the foundation track (F1, F-ACT).';

-- 8. The ledger settings' words follow their new bounds.
COMMENT ON TABLE public.context_ledger_settings IS
 'Context ledger: the ledger lane''s switch (20261006010000). mode off = no reads; shadow = read jobs into shadow generations nobody is shown; live = promote passing generations and keep them current. calls_per_day is the lane''s own ceiling inside the day''s shared model calls (context_cadence_policy model_call_cap, 1000 a Perth day since the call budget 20261006060000), 0 to 1000; the live reserve still applies. live_reserve_calls and live_reserve_calls_morning are the calls the ledger always leaves free for live fact reads (its own line, apart from the fact backlog''s context_cadence_settings). job_ids limits which jobs are read (NULL = every live job). One row; seeded off with 0 calls, a 100-call reserve both ways and no list. Service role only.';
COMMENT ON COLUMN public.context_ledger_settings.live_reserve_calls IS
 'Context ledger: calls the ledger always leaves free for live fact reads, all day (20261006010000). The ledger stops at model_call_cap less this, whatever the fact backlog''s own reserve (context_cadence_settings) is. 50 to 1000 (never below 50; the upper bound follows the day''s cap since 20261006060000); default 100.';
COMMENT ON COLUMN public.context_ledger_settings.live_reserve_calls_morning IS
 'Context ledger: calls the ledger always leaves free for live fact reads before morning_until (20261006010000). Before then the ledger also stops at morning_cap less this. 50 to 1000 (never below 50; the upper bound follows the day''s cap since 20261006060000); default 100.';

-- 9. Proof in the same transaction: every body is the one written above, and
-- the policy answers the ruled numbers with everything else as before.
DO $verify$
DECLARE x record; live text; pol jsonb := public.context_cadence_policy();
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.reserve_context_model_call(text,uuid,uuid)', '0d741538d7874ce63d48e54d8645d18c'),
  ('public.context_ledger_budget()', '8f7b42529db2e1062283de005cef01a7'),
  ('public.context_document_vision_policy()', '160abaf805bacd50e6ee570385c67037'),
  ('public.context_document_vision_admission()', 'f1d33b0f0ee54516941ee313cb7fe756'),
  ('public.context_core_status()', '2b6b2c54daeae381cdeff7802d72df81')) AS t(sig, md5) LOOP
  SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid = to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.md5 THEN RAISE EXCEPTION 'context_call_budget_body_mismatch: % md5 %', x.sig, live; END IF;
 END LOOP;
 SELECT md5(regexp_replace(prosrc, '(''live_since'','')[^'']*('')', '\1<live_since>\2')) INTO live
 FROM pg_proc WHERE oid = 'public.context_cadence_policy()'::regprocedure;
 IF live IS DISTINCT FROM '69f9fb689b28d17679d45601e59f5b09' OR (pol ->> 'model_call_cap')::integer <> 1000
  OR (pol ->> 'morning_cap')::integer <> 750 OR (pol ->> 'attribution_calls_day')::integer <> 300 OR pol ->> 'morning_until' <> '12:00'
  OR (public.context_document_vision_policy() ->> 'shared_calls_ceiling')::integer <> 500 THEN
  RAISE EXCEPTION 'context_call_budget_policy_mismatch: %', pol;
 END IF;
END $verify$;
