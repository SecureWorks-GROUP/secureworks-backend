-- Contract: 20261006060000_context_call_budget_1000 (owner ruling, 6 Oct
-- 2026: 1,000 model calls a Perth day, 750 before noon, 300 for placement,
-- vision while the day is under 500, the live reserves unchanged). Every
-- fixture write is rolled back. Ids and job numbers are synthetic.
--
--  1. The ruled budget admits what the old one refused: with 400 calls used,
--     call 401 is reserved for every phase (the old cap answered cap), the
--     day runs to call 1,000 and call 1,001 is refused with nothing reserved.
--  2. Placement (attribution) gets 300 a day, then attribution_budget (limit
--     300); every other phase goes on; the cap still answers first.
--  3. Vision only while the day is under 500; the job reads keep the rest;
--     the vision admission read agrees with the reservation.
--  4. The live reserves are intact: a catch-up-only job stops at 900 calls
--     (650 before noon) while a live job reads on to 1,000 (750 before noon);
--     the ledger stops at 900 (650 before noon) and its budget read agrees.
--  5. The heartbeat and the status blocks state the new numbers.
--  6. The bounds: reservations 1 to 1,000; ledger settings up to 1,000.
--  7. Shape: the policy is K1's text with three numbers changed and
--     live_since kept, the vision policy differs only in its ceiling, the
--     readers this migration leaves alone are untouched, grants and comments.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.cb_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'call budget contract: %', p_msg; END IF; END $$;
CREATE FUNCTION pg_temp.cb_today() RETURNS date LANGUAGE sql AS $$ SELECT (now() AT TIME ZONE 'Australia/Perth')::date $$;
-- The live policy (this migration's numbers), so overrides change only what
-- a section names (the morning boundary, live_since).
CREATE TABLE pg_temp.cb_base_policy AS SELECT public.context_cadence_policy() AS p;
CREATE FUNCTION pg_temp.cb_policy(p_over jsonb DEFAULT '{}'::jsonb) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE format('CREATE OR REPLACE FUNCTION public.context_cadence_policy() RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $b$ SELECT %L::jsonb $b$',
  (SELECT p FROM pg_temp.cb_base_policy) || jsonb_build_object('live_since', now() - interval '10 days') || p_over);
END $$;
-- Exactly p_n calls today, ordinals 1..p_n, every phase counting.
CREATE FUNCTION pg_temp.cb_calls(p_n integer, p_phase text DEFAULT 'bucket') RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM public.context_model_call_reservations WHERE run_date = pg_temp.cb_today();
 INSERT INTO public.context_model_call_reservations (run_date, ordinal, phase, reserved_at)
  SELECT pg_temp.cb_today(), g, p_phase, now() FROM generate_series(1, p_n) g;
END $$;
CREATE FUNCTION pg_temp.cb_calls_add(p_n integer, p_phase text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE m integer;
BEGIN
 SELECT coalesce(max(ordinal), 0) INTO m FROM public.context_model_call_reservations WHERE run_date = pg_temp.cb_today();
 INSERT INTO public.context_model_call_reservations (run_date, ordinal, phase, reserved_at)
  SELECT pg_temp.cb_today(), m + g, p_phase, now() FROM generate_series(1, p_n) g;
END $$;
CREATE FUNCTION pg_temp.cb_used() RETURNS integer LANGUAGE sql AS $$
 SELECT count(*)::integer FROM public.context_model_call_reservations WHERE run_date = pg_temp.cb_today() $$;
CREATE FUNCTION pg_temp.cb_lanes(p_capture boolean, p_attribution boolean, p_extraction boolean) RETURNS void LANGUAGE sql AS $$
 UPDATE public.automation_switches SET capture = p_capture, attribution = p_attribution, extraction = p_extraction, all_stop = false WHERE id = 1 $$;
CREATE FUNCTION pg_temp.cb_job(p_number text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid := gen_random_uuid();
BEGIN
 INSERT INTO public.jobs (id, org_id, status, type, job_number, metadata, created_at)
 VALUES (j, '00000000-0000-0000-0000-000000000001', 'scheduled', 'fencing', p_number, '{}', now() - interval '60 days');
 RETURN j;
END $$;
-- A running run holding its lease, for the phases that need one.
CREATE FUNCTION pg_temp.cb_run(p_job uuid, p_phase text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid; s integer;
BEGIN
 SELECT coalesce(max(run_seq), 0) + 1 INTO s FROM public.context_extraction_runs
 WHERE job_id = p_job AND run_date = pg_temp.cb_today() AND phase = p_phase;
 INSERT INTO public.context_extraction_runs (job_id, run_date, phase, status, lease_token, lease_expires_at, run_seq, started_at)
 VALUES (p_job, pg_temp.cb_today(), p_phase, 'running', gen_random_uuid(), now() + interval '30 minutes', s, now() - interval '3 hours')
 RETURNING id INTO v;
 RETURN v;
END $$;
CREATE FUNCTION pg_temp.cb_token(p_run uuid) RETURNS uuid LANGUAGE sql AS $$
 SELECT lease_token FROM public.context_extraction_runs WHERE id = p_run $$;
-- One reservation, its answer without the random id.
CREATE FUNCTION pg_temp.cb_reserve(p_phase text, p_run uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.reserve_context_model_call(p_phase, p_run, CASE WHEN p_run IS NULL THEN NULL ELSE pg_temp.cb_token(p_run) END) - 'reservation_id' $$;
-- A row through the real trigger, then moved p_ago back. p_history strips
-- written_as, as on every row captured before K1 went live.
CREATE FUNCTION pg_temp.cb_ev(p_job uuid, p_body text, p_ago interval, p_history boolean) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE new_id uuid;
BEGIN
 INSERT INTO public.business_events (job_id, match_method, direction, event_type, source, payload, occurred_at, event_at)
 VALUES (p_job, 'direct_job_id', 'inbound', 'client.sms_in', 'call_budget_contract', jsonb_build_object('body', p_body), now() - p_ago, now() - p_ago)
 RETURNING id INTO new_id;
 UPDATE public.business_events SET context_captured_at = now() - p_ago,
  attributed_at = CASE WHEN attributed_at IS NULL THEN NULL ELSE now() - p_ago END,
  metadata = CASE WHEN p_history THEN coalesce(metadata, '{}'::jsonb) - 'written_as' ELSE metadata END WHERE id = new_id;
 RETURN new_id;
END $$;
-- A backlog job: history only, listed by a backlog writer.
CREATE FUNCTION pg_temp.cb_backlog(p_number text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid := pg_temp.cb_job(p_number);
BEGIN
 PERFORM pg_temp.cb_ev(j, 'Old message', '12 days', true);
 INSERT INTO public.context_catchup_jobs (job_id, job_number, priority, mode, scope) VALUES (j, p_number, 2, 'full', 'backlog');
 RETURN j;
END $$;
-- A live job: a customer text 30 minutes ago (past the 15-minute quiet time).
CREATE FUNCTION pg_temp.cb_live(p_number text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid := pg_temp.cb_job(p_number);
BEGIN
 PERFORM pg_temp.cb_ev(j, 'Can you come Tuesday?', '30 minutes', false);
 RETURN j;
END $$;
CREATE FUNCTION pg_temp.cb_cadence(p_job uuid) RETURNS jsonb LANGUAGE sql AS $$
 SELECT x.cadence FROM public.context_jobs_cadence(ARRAY[p_job]) x $$;
CREATE FUNCTION pg_temp.cb_cand(p_job uuid) RETURNS boolean LANGUAGE sql AS $$
 SELECT EXISTS (SELECT 1 FROM public.context_extraction_candidates(400) c WHERE c.job_id = p_job) $$;

-- 1. The old caps refuse call 401; the ruled budget admits it for every phase
-- and runs to call 1,000.
BEGIN;
DO $c$
DECLARE j uuid := pg_temp.cb_job('CB-90001'); x uuid; a uuid; r jsonb; ph text;
BEGIN
 PERFORM pg_temp.cb_lanes(true, true, true);
 x := pg_temp.cb_run(j, 'extraction');
 PERFORM pg_temp.cb_calls(400);
 r := pg_temp.cb_reserve('extraction', x);
 PERFORM pg_temp.cb_assert(r = jsonb_build_object('outcome', 'reserved', 'run_date', pg_temp.cb_today(), 'ordinal', 401),
  'call 401 must be admitted (the old 400 cap answered cap): ' || r::text);
 FOREACH ph IN ARRAY ARRAY['bucket', 'attribution', 'vision'] LOOP
  r := pg_temp.cb_reserve(ph);
  PERFORM pg_temp.cb_assert(r ->> 'outcome' = 'reserved', format('phase %s past 400 must be admitted: %s', ph, r));
 END LOOP;
 a := pg_temp.cb_run(j, 'attribution');
 PERFORM pg_temp.cb_assert(pg_temp.cb_reserve('attribution', a) ->> 'outcome' = 'reserved', 'an attribution run past 400');
 PERFORM pg_temp.cb_assert(pg_temp.cb_used() = 405, 'five calls reserved past 400: ' || pg_temp.cb_used());
 -- The last call of the day is 1,000; 1,001 is refused for every phase and reserves nothing.
 PERFORM pg_temp.cb_calls(999);
 r := pg_temp.cb_reserve('extraction', x);
 PERFORM pg_temp.cb_assert(r ->> 'outcome' = 'reserved' AND (r ->> 'ordinal')::integer = 1000, 'call 1,000 must be admitted: ' || r::text);
 PERFORM pg_temp.cb_assert(pg_temp.cb_reserve('extraction', x) = '{"outcome":"cap"}', 'call 1,001 (extraction) must be refused at the cap');
 FOREACH ph IN ARRAY ARRAY['bucket', 'attribution', 'vision'] LOOP
  r := pg_temp.cb_reserve(ph);
  PERFORM pg_temp.cb_assert(r = '{"outcome":"cap"}', format('phase %s past 1,000 must answer cap: %s', ph, r));
 END LOOP;
 PERFORM pg_temp.cb_assert(pg_temp.cb_reserve('attribution', a) = '{"outcome":"cap"}', 'an attribution run past 1,000');
 PERFORM pg_temp.cb_assert(pg_temp.cb_used() = 1000, 'a refused call reserved a slot: ' || pg_temp.cb_used());
 -- Yesterday's calls never count against today.
 DELETE FROM public.context_model_call_reservations WHERE run_date = pg_temp.cb_today() - 1;
 UPDATE public.context_model_call_reservations SET run_date = pg_temp.cb_today() - 1 WHERE run_date = pg_temp.cb_today();
 PERFORM pg_temp.cb_assert(pg_temp.cb_reserve('bucket') ->> 'ordinal' = '1', 'yesterday''s 1,000 calls counted against today');
END $c$;
ROLLBACK;

-- 2. Placement gets 300 a day; the cap answers first.
BEGIN;
DO $c$
DECLARE r jsonb;
BEGIN
 PERFORM pg_temp.cb_lanes(true, true, true);
 -- 60 was the old line: with 60 used, placement is still admitted.
 PERFORM pg_temp.cb_calls(60, 'attribution');
 PERFORM pg_temp.cb_assert(pg_temp.cb_reserve('attribution') ->> 'outcome' = 'reserved', 'the 61st placement call (the old 60 line) must be admitted');
 PERFORM pg_temp.cb_calls(299, 'attribution');
 r := pg_temp.cb_reserve('attribution');
 PERFORM pg_temp.cb_assert(r ->> 'outcome' = 'reserved' AND (r ->> 'ordinal')::integer = 300, 'the 300th placement call must be admitted: ' || r::text);
 r := pg_temp.cb_reserve('attribution');
 PERFORM pg_temp.cb_assert(r = jsonb_build_object('outcome', 'attribution_budget', 'run_date', pg_temp.cb_today(), 'limit', 300),
  'the 301st placement call must be refused with limit 300: ' || r::text);
 PERFORM pg_temp.cb_assert(pg_temp.cb_used() = 300, 'a refused placement call reserved a slot');
 r := pg_temp.cb_reserve('bucket');
 PERFORM pg_temp.cb_assert(r ->> 'outcome' = 'reserved' AND (r ->> 'ordinal')::integer = 301, 'other phases do not share placement''s 300: ' || r::text);
 -- Placement's share inside a full day: the cap answers, not the share.
 PERFORM pg_temp.cb_calls(1000, 'bucket');
 PERFORM pg_temp.cb_assert(pg_temp.cb_reserve('attribution') = '{"outcome":"cap"}', 'placement at the cap must answer cap');
END $c$;
ROLLBACK;

-- 3. Vision only while the day is under 500.
BEGIN;
DO $c$
DECLARE r jsonb; adm jsonb;
BEGIN
 PERFORM pg_temp.cb_lanes(true, true, true);
 DELETE FROM public.feature_flags WHERE flag_name = 'context_document_vision_v1';
 INSERT INTO public.feature_flags (flag_name, enabled, description) VALUES ('context_document_vision_v1', true, 'call budget contract fixture');
 DELETE FROM public.context_document_vision_settings;
 -- 200 was the old ceiling: call 201 may now be vision.
 PERFORM pg_temp.cb_calls(200);
 r := pg_temp.cb_reserve('vision');
 PERFORM pg_temp.cb_assert(r ->> 'outcome' = 'reserved' AND (r ->> 'ordinal')::integer = 201, 'call 201 (the old 200 ceiling) must be admitted to vision: ' || r::text);
 PERFORM pg_temp.cb_calls(499);
 adm := public.context_document_vision_admission();
 PERFORM pg_temp.cb_assert((adm ->> 'open')::boolean AND (adm ->> 'shared_calls_ceiling')::integer = 500 AND (adm ->> 'calls_used_today')::integer = 499,
  'the vision admission must be open at 499 calls: ' || adm::text);
 r := pg_temp.cb_reserve('vision');
 PERFORM pg_temp.cb_assert(r ->> 'outcome' = 'reserved' AND (r ->> 'ordinal')::integer = 500, 'call 500 may be vision: ' || r::text);
 r := pg_temp.cb_reserve('vision');
 PERFORM pg_temp.cb_assert(r = jsonb_build_object('outcome', 'vision_reserve', 'run_date', pg_temp.cb_today(), 'ceiling', 500),
  'vision must stop once the day has 500 calls: ' || r::text);
 adm := public.context_document_vision_admission();
 PERFORM pg_temp.cb_assert(NOT (adm ->> 'open')::boolean AND adm ->> 'code' = 'vision_reserve', 'the vision admission must say vision_reserve at 500: ' || adm::text);
 r := pg_temp.cb_reserve('bucket');
 PERFORM pg_temp.cb_assert(r ->> 'outcome' = 'reserved' AND (r ->> 'ordinal')::integer = 501, 'the job reads keep the calls past 500: ' || r::text);
 -- The vision admission's cap line is the policy's.
 PERFORM pg_temp.cb_calls(999);
 PERFORM pg_temp.cb_assert(public.context_document_vision_admission() ->> 'code' = 'vision_reserve', 'vision at 999 calls is the share, not the cap');
 PERFORM pg_temp.cb_calls(1000);
 PERFORM pg_temp.cb_assert(public.context_document_vision_admission() ->> 'code' = 'cap', 'the vision admission must say cap at 1,000 calls');
 PERFORM pg_temp.cb_assert(pg_temp.cb_reserve('vision') = '{"outcome":"cap"}', 'vision at 1,000 calls must answer cap');
 -- The status block reports the ruled ceiling.
 PERFORM pg_temp.cb_assert((public.context_document_vision_status() #>> '{policy,shared_calls_ceiling}')::integer = 500
  AND (public.context_document_vision_status() #>> '{admission,shared_calls_ceiling}')::integer = 500, 'the vision status block must state 500');
END $c$;
ROLLBACK;

-- 4a. The fact backlog keeps the live reserve: a catch-up-only job stops at
-- 900 calls all day and 650 before noon; a live job reads on to 1,000, and to
-- 750 before noon.
BEGIN;
DO $c$
DECLARE b uuid; l uuid; c jsonb; claim jsonb; d date := pg_temp.cb_today(); st jsonb;
BEGIN
 PERFORM pg_temp.cb_lanes(true, true, true);
 DELETE FROM public.context_cadence_settings;
 INSERT INTO public.context_cadence_settings (id) VALUES (true);
 PERFORM pg_temp.cb_policy('{"morning_until":"00:00"}');   -- never morning
 b := pg_temp.cb_backlog('CB-90011'); l := pg_temp.cb_live('CB-90012');
 PERFORM pg_temp.cb_calls(899);
 c := pg_temp.cb_cadence(b);
 PERFORM pg_temp.cb_assert((c ->> 'due')::boolean AND (c ->> 'catchup_only')::boolean AND NOT (c ->> 'backlog_budget_held')::boolean AND pg_temp.cb_cand(b),
  'a catch-up-only job must be due at 899 calls: ' || c::text);
 PERFORM pg_temp.cb_calls(900);
 c := pg_temp.cb_cadence(b);
 PERFORM pg_temp.cb_assert(NOT (c ->> 'due')::boolean AND c ->> 'blocked_reason' = 'backlog_budget' AND NOT pg_temp.cb_cand(b),
  'a catch-up-only job must be held at 900 calls (1,000 less the day reserve of 100): ' || c::text);
 claim := public.claim_context_extraction_run(b, d, 'extraction');
 PERFORM pg_temp.cb_assert(claim ->> 'outcome' = 'pacing' AND claim ->> 'reason' = 'backlog_budget', 'the claim must refuse a backlog read at 900: ' || claim::text);
 PERFORM pg_temp.cb_calls(999);
 c := pg_temp.cb_cadence(l);
 PERFORM pg_temp.cb_assert((c ->> 'due')::boolean AND c ->> 'blocked_reason' IS NULL AND pg_temp.cb_cand(l), 'a live job must stay due at 999 calls: ' || c::text);
 claim := public.claim_context_extraction_run(l, d, 'extraction');
 PERFORM pg_temp.cb_assert(claim ->> 'outcome' = 'claimed', 'a live claim at 999 calls: ' || claim::text);
 DELETE FROM public.context_extraction_runs WHERE job_id = l;
 PERFORM pg_temp.cb_calls(1000);
 PERFORM pg_temp.cb_assert(pg_temp.cb_cadence(l) ->> 'blocked_reason' = 'model_cap' AND pg_temp.cb_cadence(b) ->> 'blocked_reason' = 'model_cap',
  'both must be held model_cap at 1,000 calls');
 -- Before noon: the backlog stops at 650 (750 less the morning reserve of
 -- 100); a live job is due to 749 and paced at 750.
 PERFORM pg_temp.cb_policy('{"morning_until":"23:59:59.999"}');
 PERFORM pg_temp.cb_calls(649);
 PERFORM pg_temp.cb_assert((pg_temp.cb_cadence(b) ->> 'due')::boolean, 'a catch-up-only job must be due at 649 calls before noon');
 PERFORM pg_temp.cb_calls(650);
 c := pg_temp.cb_cadence(b);
 PERFORM pg_temp.cb_assert(NOT (c ->> 'due')::boolean AND c ->> 'blocked_reason' = 'backlog_budget', 'the morning backlog line is 650: ' || c::text);
 PERFORM pg_temp.cb_assert((pg_temp.cb_cadence(l) ->> 'due')::boolean, 'a live job must be due at 650 calls before noon');
 PERFORM pg_temp.cb_calls(749);
 PERFORM pg_temp.cb_assert((pg_temp.cb_cadence(l) ->> 'due')::boolean, 'a live job must be due at 749 calls before noon');
 PERFORM pg_temp.cb_calls(750);
 c := pg_temp.cb_cadence(l);
 PERFORM pg_temp.cb_assert(NOT (c ->> 'due')::boolean AND c ->> 'blocked_reason' = 'pacing_reserve' AND (c ->> 'pacing_held')::boolean,
  'the morning cap is 750: ' || c::text);
 claim := public.claim_context_extraction_run(l, d, 'extraction');
 PERFORM pg_temp.cb_assert(claim ->> 'outcome' = 'pacing' AND claim ->> 'reason' = 'pacing_reserve', 'the claim must pace at 750 before noon: ' || claim::text);
 -- The status block publishes both lines.
 st := public.context_cadence_status();
 PERFORM pg_temp.cb_assert((st #>> '{read_reserve,backlog_ceiling_day}')::integer = 900 AND (st #>> '{read_reserve,backlog_ceiling_morning}')::integer = 650
  AND (st #>> '{read_reserve,calls_day}')::integer = 100 AND (st #>> '{read_reserve,calls_morning}')::integer = 100,
  'the cadence block''s read_reserve: ' || (st -> 'read_reserve')::text);
END $c$;
ROLLBACK;

-- 4b. The ledger keeps its own live reserve: it stops at 900 calls all day and
-- 650 before noon, the fact reads go on above it, and its budget read agrees.
BEGIN;
DO $c$
DECLARE j uuid := pg_temp.cb_job('CB-90021'); lr uuid; x uuid; r jsonb; b jsonb;
BEGIN
 PERFORM pg_temp.cb_lanes(true, true, true);
 UPDATE public.context_ledger_settings SET mode = 'live', calls_per_day = 1000, live_reserve_calls = 100, live_reserve_calls_morning = 100, job_ids = NULL;
 PERFORM pg_temp.cb_policy('{"morning_until":"00:00"}');   -- never morning
 lr := pg_temp.cb_run(j, 'ledger'); x := pg_temp.cb_run(j, 'extraction');
 PERFORM pg_temp.cb_calls(0);
 b := public.context_ledger_budget();
 PERFORM pg_temp.cb_assert((b ->> 'calls_left')::integer = 900 AND b ->> 'reason' IS NULL, 'the ledger may use 900 of an empty day: ' || b::text);
 PERFORM pg_temp.cb_calls(899);
 b := public.context_ledger_budget();
 PERFORM pg_temp.cb_assert((b ->> 'calls_left')::integer = 1, 'one ledger call left at 899: ' || b::text);
 r := pg_temp.cb_reserve('ledger', lr);
 PERFORM pg_temp.cb_assert(r ->> 'outcome' = 'reserved' AND (r ->> 'ordinal')::integer = 900, 'ledger call 900 must be admitted: ' || r::text);
 r := pg_temp.cb_reserve('ledger', lr);
 PERFORM pg_temp.cb_assert(r = jsonb_build_object('outcome', 'ledger_budget', 'reason', 'live_reserve', 'run_date', pg_temp.cb_today(), 'ceiling', 900),
  'the ledger must stop at 900 (1,000 less its reserve of 100): ' || r::text);
 b := public.context_ledger_budget();
 PERFORM pg_temp.cb_assert((b ->> 'calls_left')::integer = 0 AND b ->> 'reason' = 'live_reserve', 'the ledger budget read must agree at 900: ' || b::text);
 r := pg_temp.cb_reserve('extraction', x);
 PERFORM pg_temp.cb_assert(r ->> 'outcome' = 'reserved' AND (r ->> 'ordinal')::integer = 901, 'a fact read inside the ledger''s reserve: ' || r::text);
 -- Before noon: 750 less the morning reserve of 100.
 PERFORM pg_temp.cb_policy('{"morning_until":"23:59:59.999"}');
 PERFORM pg_temp.cb_calls(649);
 r := pg_temp.cb_reserve('ledger', lr);
 PERFORM pg_temp.cb_assert(r ->> 'outcome' = 'reserved' AND (r ->> 'ordinal')::integer = 650, 'ledger call 650 before noon: ' || r::text);
 r := pg_temp.cb_reserve('ledger', lr);
 PERFORM pg_temp.cb_assert(r ->> 'reason' = 'live_reserve_morning' AND (r ->> 'ceiling')::integer = 650, 'the ledger''s morning line is 650: ' || r::text);
 b := public.context_ledger_budget();
 PERFORM pg_temp.cb_assert((b ->> 'calls_left')::integer = 0 AND b ->> 'reason' = 'live_reserve_morning', 'the budget read agrees before noon: ' || b::text);
 -- The ledger's cap line is the policy's: at 1,000 the budget says cap.
 PERFORM pg_temp.cb_calls(1000);
 b := public.context_ledger_budget();
 PERFORM pg_temp.cb_assert((b ->> 'calls_left')::integer = 0 AND b ->> 'reason' = 'cap', 'the ledger budget at 1,000 calls: ' || b::text);
 PERFORM pg_temp.cb_assert(pg_temp.cb_reserve('ledger', lr) = '{"outcome":"cap"}', 'a ledger call at 1,000');
END $c$;
ROLLBACK;

-- 5. The heartbeat states the ruled numbers.
DO $c$
DECLARE core jsonb := public.context_core_status(); pipe jsonb := public.context_pipeline_status();
BEGIN
 PERFORM pg_temp.cb_assert((core ->> 'model_call_cap')::integer = 1000 AND (core ->> 'run_cap')::integer = 1000,
  'the core status must report a cap of 1,000: ' || (core - 'coverage' - 'switches')::text);
 PERFORM pg_temp.cb_assert((pipe ->> 'model_call_cap')::integer = 1000 AND (pipe ->> 'run_cap')::integer = 1000,
  'the heartbeat must report a cap of 1,000 at top level');
 PERFORM pg_temp.cb_assert((pipe #>> '{cadence,policy,model_call_cap}')::integer = 1000 AND (pipe #>> '{cadence,policy,morning_cap}')::integer = 750
  AND (pipe #>> '{cadence,policy,attribution_calls_day}')::integer = 300, 'the cadence block''s policy: ' || (pipe #> '{cadence,policy}')::text);
 -- The ready-jobs list keeps its own size: it is not the call budget.
 PERFORM pg_temp.cb_assert(core ? 'ready_jobs_is_lower_bound' AND core ? 'ready_jobs', 'ready_jobs keys');
END $c$;

-- 6. The bounds follow the day's cap.
BEGIN;
DO $c$
DECLARE c text;
BEGIN
 PERFORM pg_temp.cb_calls(0);
 INSERT INTO public.context_model_call_reservations (run_date, ordinal, phase, reserved_at) VALUES (pg_temp.cb_today(), 1000, 'bucket', now());
 BEGIN
  INSERT INTO public.context_model_call_reservations (run_date, ordinal, phase, reserved_at) VALUES (pg_temp.cb_today(), 1001, 'bucket', now());
  RAISE EXCEPTION 'call budget contract: a reservation numbered 1,001 was stored';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  INSERT INTO public.context_model_call_reservations (run_date, ordinal, phase, reserved_at) VALUES (pg_temp.cb_today(), 0, 'bucket', now());
  RAISE EXCEPTION 'call budget contract: a reservation numbered 0 was stored';
 EXCEPTION WHEN check_violation THEN NULL; END;
 UPDATE public.context_ledger_settings SET calls_per_day = 1000, live_reserve_calls = 1000, live_reserve_calls_morning = 1000;
 FOREACH c IN ARRAY ARRAY['calls_per_day', 'live_reserve_calls', 'live_reserve_calls_morning'] LOOP
  BEGIN
   EXECUTE format('UPDATE public.context_ledger_settings SET %I = 1001', c);
   RAISE EXCEPTION 'call budget contract: ledger settings % of 1,001 was stored', c;
  EXCEPTION WHEN check_violation THEN NULL; END;
 END LOOP;
 BEGIN
  UPDATE public.context_ledger_settings SET live_reserve_calls = 49;
  RAISE EXCEPTION 'call budget contract: a ledger reserve below 50 was stored';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE public.context_ledger_settings SET calls_per_day = -1;
  RAISE EXCEPTION 'call budget contract: a negative ledger ceiling was stored';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $c$;
ROLLBACK;

-- 7. Shape: only the ruled numbers moved.
DO $c$
DECLARE pre public.call_budget_contract_preimage; pol jsonb := public.context_cadence_policy(); src text; x record; live text;
 old_frag constant text := $o$'attribution_calls_day',60,'model_call_cap',400,'morning_cap',300,$o$;
 new_frag constant text := $n$'attribution_calls_day',300,'model_call_cap',1000,'morning_cap',750,$n$;
 keys constant text[] := ARRAY['model_call_cap', 'morning_cap', 'attribution_calls_day'];
BEGIN
 SELECT * INTO pre FROM public.call_budget_contract_preimage;
 SELECT prosrc INTO src FROM pg_proc WHERE oid = 'public.context_cadence_policy()'::regprocedure;
 PERFORM pg_temp.cb_assert(src = replace(pre.policy_src, old_frag, new_frag) AND src <> pre.policy_src,
  'the policy text must be K1''s with only the three numbers changed');
 PERFORM pg_temp.cb_assert(md5(regexp_replace(src, '(''live_since'','')[^'']*('')', '\1<live_since>\2')) = '69f9fb689b28d17679d45601e59f5b09',
  'the policy''s masked md5');
 PERFORM pg_temp.cb_assert((pol ->> 'model_call_cap')::integer = 1000 AND (pol ->> 'morning_cap')::integer = 750
  AND (pol ->> 'attribution_calls_day')::integer = 300 AND pol ->> 'morning_until' = '12:00', 'the ruled numbers: ' || pol::text);
 PERFORM pg_temp.cb_assert((pol - keys) = (pre.policy - keys), 'every other cadence number and live_since must be unchanged: ' || (pol - keys)::text);
 PERFORM pg_temp.cb_assert(public.context_document_vision_policy() = pre.vision_policy || '{"shared_calls_ceiling":500}'::jsonb
  AND (pre.vision_policy ->> 'shared_calls_ceiling')::integer = 200, 'the vision policy may change only its ceiling, 200 to 500');
 -- The live reserves are unchanged.
 PERFORM pg_temp.cb_assert((SELECT live_reserve_calls_day = 100 AND live_reserve_calls_morning = 100 AND live_reserve_reads_per_job = 2
  FROM public.context_cadence_settings WHERE id), 'the fact backlog''s reserve must stay 100, 100 and 2');
 PERFORM pg_temp.cb_assert((SELECT live_reserve_calls = 100 AND live_reserve_calls_morning = 100 FROM public.context_ledger_settings WHERE id),
  'the ledger''s reserve must stay 100 and 100');
 -- Readers of the policy are untouched; the replaced bodies are this migration's.
 PERFORM pg_temp.cb_assert((SELECT jsonb_object_agg(p.oid::regprocedure::text, md5(p.prosrc)) FROM pg_proc p
   WHERE p.oid::regprocedure::text IN (SELECT jsonb_object_keys(pre.untouched))) = pre.untouched, 'a reader this migration leaves alone moved');
 FOR x IN SELECT * FROM (VALUES
  ('public.reserve_context_model_call(text,uuid,uuid)', '0d741538d7874ce63d48e54d8645d18c'),
  ('public.context_ledger_budget()', '8f7b42529db2e1062283de005cef01a7'),
  ('public.context_document_vision_policy()', '160abaf805bacd50e6ee570385c67037'),
  ('public.context_document_vision_admission()', 'f1d33b0f0ee54516941ee313cb7fe756'),
  ('public.context_core_status()', '2b6b2c54daeae381cdeff7802d72df81')) AS t(sig, md5) LOOP
  SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid = to_regprocedure(x.sig);
  PERFORM pg_temp.cb_assert(live = x.md5, format('%s md5 %s', x.sig, live));
 END LOOP;
 -- No number of the old budget is left in a body that decides a call.
 PERFORM pg_temp.cb_assert(position('>400' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.reserve_context_model_call(text,uuid,uuid)'::regprocedure)) = 0
  AND position('>=60' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.reserve_context_model_call(text,uuid,uuid)'::regprocedure)) = 0
  AND position('400 - v_max' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.context_ledger_budget()'::regprocedure)) = 0
  AND position('used>=400' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.context_document_vision_admission()'::regprocedure)) = 0,
  'a hard-coded 400 or 60 is still deciding a call');
 -- Grants: service role only, as before.
 FOR x IN SELECT unnest(ARRAY['public.reserve_context_model_call(text,uuid,uuid)', 'public.context_ledger_budget()',
   'public.context_document_vision_policy()', 'public.context_document_vision_admission()', 'public.context_core_status()',
   'public.context_cadence_policy()']) AS sig LOOP
  PERFORM pg_temp.cb_assert(NOT has_function_privilege('anon', x.sig, 'EXECUTE') AND NOT has_function_privilege('authenticated', x.sig, 'EXECUTE')
   AND has_function_privilege('service_role', x.sig, 'EXECUTE'), x.sig || ' grants');
 END LOOP;
 PERFORM pg_temp.cb_assert(obj_description('public.context_cadence_policy()'::regprocedure, 'pg_proc') LIKE '%20261006060000%'
  AND obj_description('public.reserve_context_model_call(text,uuid,uuid)'::regprocedure, 'pg_proc') LIKE '%1000%'
  AND obj_description('public.context_ledger_settings'::regclass, 'pg_class') LIKE '%0 to 1000%', 'the comments must state the new budget');
END $c$;
