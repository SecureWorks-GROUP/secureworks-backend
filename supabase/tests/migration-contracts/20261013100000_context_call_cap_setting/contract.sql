-- Contract: 20261013100000_context_call_cap_setting (the day's call cap follows
-- context_ledger_settings.calls_per_day, and only upward). Every fixture write is rolled back.
-- Ids and job numbers are synthetic.
--
--  1. Defaults: with calls_per_day at or under the policy's cap (0, 1, 300, 999, 1,000), with no
--     settings row and with no settings table, context_cadence_policy_today() is the policy
--     exactly: 1,000 calls a day and 750 before noon.
--  2. A raise: above 1,000 the day's cap is calls_per_day and the before-noon line keeps the
--     policy's share (three quarters): 1,500 gives 1,125; 3,000 gives 2,250. No other key moves,
--     and a policy replaced in the same transaction is read at once.
--  3. The admission: at the default the day ends at call 1,000; a lowered ledger ceiling (300)
--     throttles the ledger alone; raised to 1,500 the day runs to call 1,500 for every phase.
--  4. The ledger's lines follow a raise: 1,400 all day and 1,025 before noon at 1,500, and its
--     budget read agrees.
--  5. The fact reads follow a raise: the backlog stops at 1,400 (1,025 before noon), a live job
--     reads on to 1,500 (1,125 before noon), and the status block says so.
--  6. The heartbeat, the vision admission and the story budget state the raised cap; vision keeps
--     its own 500 share.
--  7. Shape: the bounds (3,000), the new column, the seven bodies (each the earlier body with only
--     the policy call changed), nothing else reads a cap, the policy untouched, grants, comments.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.cs_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'call cap setting contract: %', p_msg; END IF; END $$;
CREATE FUNCTION pg_temp.cs_today() RETURNS date LANGUAGE sql AS $$ SELECT (now() AT TIME ZONE 'Australia/Perth')::date $$;
-- The live policy, so an override changes only what a section names (the morning boundary,
-- live_since).
CREATE TABLE pg_temp.cs_base_policy AS SELECT public.context_cadence_policy() AS p;
CREATE FUNCTION pg_temp.cs_policy(p_over jsonb DEFAULT '{}'::jsonb) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE format('CREATE OR REPLACE FUNCTION public.context_cadence_policy() RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $b$ SELECT %L::jsonb $b$',
  (SELECT p FROM pg_temp.cs_base_policy) || jsonb_build_object('live_since', now() - interval '10 days') || p_over);
END $$;
-- Exactly p_n calls today, ordinals 1..p_n, every phase counting.
CREATE FUNCTION pg_temp.cs_calls(p_n integer, p_phase text DEFAULT 'bucket') RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM public.context_model_call_reservations WHERE run_date = pg_temp.cs_today();
 INSERT INTO public.context_model_call_reservations (run_date, ordinal, phase, reserved_at)
  SELECT pg_temp.cs_today(), g, p_phase, now() FROM generate_series(1, p_n) g;
END $$;
CREATE FUNCTION pg_temp.cs_used() RETURNS integer LANGUAGE sql AS $$
 SELECT count(*)::integer FROM public.context_model_call_reservations WHERE run_date = pg_temp.cs_today() $$;
CREATE FUNCTION pg_temp.cs_lanes() RETURNS void LANGUAGE sql AS $$
 UPDATE public.automation_switches SET capture = true, attribution = true, extraction = true, all_stop = false WHERE id = 1 $$;
-- The ledger settings for a section: live, the usual 100 and 100 reserves, and the day's ceiling.
CREATE FUNCTION pg_temp.cs_setting(p_calls integer) RETURNS void LANGUAGE sql AS $$
 UPDATE public.context_ledger_settings SET mode = 'live', calls_per_day = p_calls, live_reserve_calls = 100,
  live_reserve_calls_morning = 100, job_ids = NULL, backfill_from_hour = NULL, backfill_to_hour = NULL $$;
CREATE FUNCTION pg_temp.cs_job(p_number text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid := gen_random_uuid();
BEGIN
 INSERT INTO public.jobs (id, org_id, status, type, job_number, metadata, created_at)
 VALUES (j, '00000000-0000-0000-0000-000000000001', 'scheduled', 'fencing', p_number, '{}', now() - interval '60 days');
 RETURN j;
END $$;
-- A running run holding its lease, for the phases that need one.
CREATE FUNCTION pg_temp.cs_run(p_job uuid, p_phase text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid; s integer;
BEGIN
 SELECT coalesce(max(run_seq), 0) + 1 INTO s FROM public.context_extraction_runs
 WHERE job_id = p_job AND run_date = pg_temp.cs_today() AND phase = p_phase;
 INSERT INTO public.context_extraction_runs (job_id, run_date, phase, status, lease_token, lease_expires_at, run_seq, started_at)
 VALUES (p_job, pg_temp.cs_today(), p_phase, 'running', gen_random_uuid(), now() + interval '30 minutes', s, now() - interval '3 hours')
 RETURNING id INTO v;
 RETURN v;
END $$;
-- One reservation, its answer without the random id.
CREATE FUNCTION pg_temp.cs_reserve(p_phase text, p_run uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.reserve_context_model_call(p_phase, p_run,
  CASE WHEN p_run IS NULL THEN NULL ELSE (SELECT lease_token FROM public.context_extraction_runs WHERE id = p_run) END) - 'reservation_id' $$;
-- A row through the real trigger, then moved p_ago back. p_history strips written_as, as on
-- every row captured before the cadence went live.
CREATE FUNCTION pg_temp.cs_ev(p_job uuid, p_body text, p_ago interval, p_history boolean) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE new_id uuid;
BEGIN
 INSERT INTO public.business_events (job_id, match_method, direction, event_type, source, payload, occurred_at, event_at)
 VALUES (p_job, 'direct_job_id', 'inbound', 'client.sms_in', 'call_cap_setting_contract', jsonb_build_object('body', p_body), now() - p_ago, now() - p_ago)
 RETURNING id INTO new_id;
 UPDATE public.business_events SET context_captured_at = now() - p_ago,
  attributed_at = CASE WHEN attributed_at IS NULL THEN NULL ELSE now() - p_ago END,
  metadata = CASE WHEN p_history THEN coalesce(metadata, '{}'::jsonb) - 'written_as' ELSE metadata END WHERE id = new_id;
 RETURN new_id;
END $$;
-- A backlog job: history only, listed by a backlog writer.
CREATE FUNCTION pg_temp.cs_backlog(p_number text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid := pg_temp.cs_job(p_number);
BEGIN
 PERFORM pg_temp.cs_ev(j, 'Old message', '12 days', true);
 INSERT INTO public.context_catchup_jobs (job_id, job_number, priority, mode, scope) VALUES (j, p_number, 2, 'full', 'backlog');
 RETURN j;
END $$;
-- A live job: a customer text 30 minutes ago (past the 15-minute quiet time).
CREATE FUNCTION pg_temp.cs_live(p_number text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid := pg_temp.cs_job(p_number);
BEGIN
 PERFORM pg_temp.cs_ev(j, 'Can you come Tuesday?', '30 minutes', false);
 RETURN j;
END $$;
CREATE FUNCTION pg_temp.cs_cadence(p_job uuid) RETURNS jsonb LANGUAGE sql AS $$
 SELECT x.cadence FROM public.context_jobs_cadence(ARRAY[p_job]) x $$;

-- 1. Defaults. At or under the policy's cap, with no row and with no table, the wrapper is the
-- policy, key for key and character for character.
BEGIN;
DO $c$
DECLARE pol jsonb := public.context_cadence_policy(); today jsonb; n integer;
BEGIN
 PERFORM pg_temp.cs_assert((pol ->> 'model_call_cap')::integer = 1000 AND (pol ->> 'morning_cap')::integer = 750,
  'the policy itself must still say 1,000 and 750: ' || pol::text);
 -- as the migration leaves it, with the settings row untouched
 PERFORM pg_temp.cs_assert(public.context_cadence_policy_today() = pol, 'the wrapper must be the policy with the settings as they are');
 FOREACH n IN ARRAY ARRAY[0, 1, 300, 999, 1000] LOOP
  UPDATE public.context_ledger_settings SET calls_per_day = n;
  today := public.context_cadence_policy_today();
  PERFORM pg_temp.cs_assert(today = pol AND today::text = pol::text,
   format('calls_per_day %s must leave the policy exactly as it is: %s', n, today));
  PERFORM pg_temp.cs_assert((today ->> 'model_call_cap')::integer = 1000 AND (today ->> 'morning_cap')::integer = 750,
   format('calls_per_day %s must keep 1,000 and 750', n));
 END LOOP;
 DELETE FROM public.context_ledger_settings;
 PERFORM pg_temp.cs_assert(public.context_cadence_policy_today() = pol, 'no settings row must answer the policy');
END $c$;
ROLLBACK;

BEGIN;
DO $c$
DECLARE pol jsonb := public.context_cadence_policy(); r jsonb;
BEGIN
 PERFORM pg_temp.cs_lanes();
 PERFORM pg_temp.cs_calls(999);
 DROP TABLE public.context_ledger_settings CASCADE;
 PERFORM pg_temp.cs_assert(public.context_cadence_policy_today() = pol, 'no settings table must answer the policy');
 r := pg_temp.cs_reserve('bucket');
 PERFORM pg_temp.cs_assert(r ->> 'outcome' = 'reserved' AND (r ->> 'ordinal')::integer = 1000, 'call 1,000 without the settings table: ' || r::text);
 PERFORM pg_temp.cs_assert(pg_temp.cs_reserve('bucket') = '{"outcome":"cap"}', 'call 1,001 without the settings table must answer cap');
END $c$;
ROLLBACK;

-- 2. A raise. Above the policy's cap the day's cap is the setting and the before-noon line keeps
-- the policy's share of the day; nothing else moves.
BEGIN;
DO $c$
DECLARE pol jsonb := public.context_cadence_policy(); today jsonb; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES (1001, 750), (1002, 751), (1500, 1125), (2000, 1500), (2999, 2249), (3000, 2250)) AS t(calls, morning) LOOP
  UPDATE public.context_ledger_settings SET calls_per_day = x.calls;
  today := public.context_cadence_policy_today();
  PERFORM pg_temp.cs_assert((today ->> 'model_call_cap')::integer = x.calls AND (today ->> 'morning_cap')::integer = x.morning,
   format('calls_per_day %s must give a cap of %s and %s before noon: %s', x.calls, x.calls, x.morning, today));
  PERFORM pg_temp.cs_assert(today - 'model_call_cap' - 'morning_cap' = pol - 'model_call_cap' - 'morning_cap',
   format('calls_per_day %s moved another key: %s', x.calls, today));
 END LOOP;
 -- The policy read is never a stale copy: a policy replaced in this transaction is read at once,
 -- and the before-noon line keeps that policy's own share (300 of 400 here).
 UPDATE public.context_ledger_settings SET calls_per_day = 1000;
 PERFORM pg_temp.cs_policy('{"model_call_cap":400,"morning_cap":300,"morning_until":"11:00"}');
 today := public.context_cadence_policy_today();
 PERFORM pg_temp.cs_assert((today ->> 'model_call_cap')::integer = 1000 AND (today ->> 'morning_cap')::integer = 750
  AND today ->> 'morning_until' = '11:00', 'a replaced policy must be read at once, raised to the setting: ' || today::text);
 UPDATE public.context_ledger_settings SET calls_per_day = 400;
 PERFORM pg_temp.cs_assert(public.context_cadence_policy_today() = public.context_cadence_policy(),
  'at the replaced policy''s own cap the wrapper must be that policy');
END $c$;
ROLLBACK;

-- 3. The admission.
BEGIN;
DO $c$
DECLARE j uuid := pg_temp.cs_job('CS-90001'); x uuid; lr uuid; r jsonb; ph text;
BEGIN
 PERFORM pg_temp.cs_lanes();
 PERFORM pg_temp.cs_policy('{"morning_until":"00:00"}');   -- never morning
 x := pg_temp.cs_run(j, 'extraction'); lr := pg_temp.cs_run(j, 'ledger');
 -- The default: the last call of the day is 1,000.
 PERFORM pg_temp.cs_setting(1000);
 PERFORM pg_temp.cs_calls(999);
 r := pg_temp.cs_reserve('extraction', x);
 PERFORM pg_temp.cs_assert(r ->> 'outcome' = 'reserved' AND (r ->> 'ordinal')::integer = 1000, 'call 1,000 at the default: ' || r::text);
 FOREACH ph IN ARRAY ARRAY['bucket', 'attribution', 'vision'] LOOP
  PERFORM pg_temp.cs_assert(pg_temp.cs_reserve(ph) = '{"outcome":"cap"}', format('phase %s past 1,000 at the default must answer cap', ph));
 END LOOP;
 PERFORM pg_temp.cs_assert(pg_temp.cs_reserve('extraction', x) = '{"outcome":"cap"}' AND pg_temp.cs_reserve('ledger', lr) = '{"outcome":"cap"}',
  'a run past 1,000 at the default must answer cap');
 PERFORM pg_temp.cs_assert(pg_temp.cs_used() = 1000, 'a refused call reserved a slot: ' || pg_temp.cs_used());
 -- A lowered ledger ceiling throttles the ledger alone: the day's cap stays 1,000.
 PERFORM pg_temp.cs_setting(300);
 PERFORM pg_temp.cs_calls(300, 'ledger');
 r := pg_temp.cs_reserve('ledger', lr);
 PERFORM pg_temp.cs_assert(r = jsonb_build_object('outcome', 'ledger_budget', 'reason', 'ledger_calls_per_day', 'run_date', pg_temp.cs_today(), 'limit', 300),
  'the ledger must stop at its own 300: ' || r::text);
 r := pg_temp.cs_reserve('extraction', x);
 PERFORM pg_temp.cs_assert(r ->> 'outcome' = 'reserved' AND (r ->> 'ordinal')::integer = 301, 'a fact read past a lowered ledger ceiling: ' || r::text);
 PERFORM pg_temp.cs_calls(999);
 r := pg_temp.cs_reserve('bucket');
 PERFORM pg_temp.cs_assert(r ->> 'outcome' = 'reserved' AND (r ->> 'ordinal')::integer = 1000, 'call 1,000 under a lowered ledger ceiling: ' || r::text);
 PERFORM pg_temp.cs_assert(pg_temp.cs_reserve('bucket') = '{"outcome":"cap"}', 'the cap must stay 1,000 under a lowered ledger ceiling');
 PERFORM pg_temp.cs_setting(0);
 PERFORM pg_temp.cs_calls(999);
 r := pg_temp.cs_reserve('extraction', x);
 PERFORM pg_temp.cs_assert(r ->> 'outcome' = 'reserved' AND (r ->> 'ordinal')::integer = 1000, 'a ledger ceiling of 0 must not stop a fact read: ' || r::text);
 -- Raised to 1,500: call 1,001 is admitted for every phase but vision (its own 500 share), the
 -- day runs to 1,500 and call 1,501 is refused with nothing reserved.
 PERFORM pg_temp.cs_setting(1500);
 PERFORM pg_temp.cs_calls(1000);
 r := pg_temp.cs_reserve('extraction', x);
 PERFORM pg_temp.cs_assert(r = jsonb_build_object('outcome', 'reserved', 'run_date', pg_temp.cs_today(), 'ordinal', 1001),
  'call 1,001 must be admitted at 1,500: ' || r::text);
 r := pg_temp.cs_reserve('bucket');
 PERFORM pg_temp.cs_assert(r ->> 'outcome' = 'reserved' AND (r ->> 'ordinal')::integer = 1002, 'a bucket call past 1,000 at 1,500: ' || r::text);
 r := pg_temp.cs_reserve('ledger', lr);
 PERFORM pg_temp.cs_assert(r ->> 'outcome' = 'reserved' AND (r ->> 'ordinal')::integer = 1003, 'a ledger call past 1,000 at 1,500: ' || r::text);
 r := pg_temp.cs_reserve('vision');
 PERFORM pg_temp.cs_assert(r ->> 'outcome' = 'vision_reserve' AND (r ->> 'ceiling')::integer = 500, 'vision keeps its own 500 share at 1,500: ' || r::text);
 PERFORM pg_temp.cs_calls(1499);
 r := pg_temp.cs_reserve('extraction', x);
 PERFORM pg_temp.cs_assert(r ->> 'outcome' = 'reserved' AND (r ->> 'ordinal')::integer = 1500, 'call 1,500 must be admitted at 1,500: ' || r::text);
 FOREACH ph IN ARRAY ARRAY['bucket', 'attribution', 'vision'] LOOP
  PERFORM pg_temp.cs_assert(pg_temp.cs_reserve(ph) = '{"outcome":"cap"}', format('phase %s past 1,500 must answer cap', ph));
 END LOOP;
 PERFORM pg_temp.cs_assert(pg_temp.cs_reserve('extraction', x) = '{"outcome":"cap"}' AND pg_temp.cs_reserve('ledger', lr) = '{"outcome":"cap"}',
  'a run past 1,500 must answer cap');
 PERFORM pg_temp.cs_assert(pg_temp.cs_used() = 1500, 'a refused call reserved a slot at 1,500: ' || pg_temp.cs_used());
 -- The setting put back: the same day is over its cap again at once.
 PERFORM pg_temp.cs_setting(1000);
 PERFORM pg_temp.cs_calls(1000);
 PERFORM pg_temp.cs_assert(pg_temp.cs_reserve('bucket') = '{"outcome":"cap"}', 'the setting put back to 1,000 must cap at 1,000 again');
END $c$;
ROLLBACK;

-- 4. The ledger's lines follow a raise: 1,400 all day (1,500 less its reserve of 100) and 1,025
-- before noon (1,125 less 100); its budget read agrees.
BEGIN;
DO $c$
DECLARE j uuid := pg_temp.cs_job('CS-90011'); lr uuid; x uuid; r jsonb; b jsonb;
BEGIN
 PERFORM pg_temp.cs_lanes();
 PERFORM pg_temp.cs_setting(1500);
 PERFORM pg_temp.cs_policy('{"morning_until":"00:00"}');   -- never morning
 lr := pg_temp.cs_run(j, 'ledger'); x := pg_temp.cs_run(j, 'extraction');
 PERFORM pg_temp.cs_calls(0);
 b := public.context_ledger_budget();
 PERFORM pg_temp.cs_assert((b ->> 'calls_left')::integer = 1400 AND b ->> 'reason' IS NULL, 'the ledger may use 1,400 of an empty day at 1,500: ' || b::text);
 PERFORM pg_temp.cs_calls(1000);
 b := public.context_ledger_budget();
 PERFORM pg_temp.cs_assert((b ->> 'calls_left')::integer = 400 AND b ->> 'reason' IS NULL, '400 ledger calls left at 1,000 of 1,500: ' || b::text);
 PERFORM pg_temp.cs_calls(1399);
 r := pg_temp.cs_reserve('ledger', lr);
 PERFORM pg_temp.cs_assert(r ->> 'outcome' = 'reserved' AND (r ->> 'ordinal')::integer = 1400, 'ledger call 1,400 must be admitted: ' || r::text);
 r := pg_temp.cs_reserve('ledger', lr);
 PERFORM pg_temp.cs_assert(r = jsonb_build_object('outcome', 'ledger_budget', 'reason', 'live_reserve', 'run_date', pg_temp.cs_today(), 'ceiling', 1400),
  'the ledger must stop at 1,400: ' || r::text);
 b := public.context_ledger_budget();
 PERFORM pg_temp.cs_assert((b ->> 'calls_left')::integer = 0 AND b ->> 'reason' = 'live_reserve', 'the ledger budget read must agree at 1,400: ' || b::text);
 r := pg_temp.cs_reserve('extraction', x);
 PERFORM pg_temp.cs_assert(r ->> 'outcome' = 'reserved' AND (r ->> 'ordinal')::integer = 1401, 'a fact read inside the ledger''s reserve: ' || r::text);
 -- Before noon.
 PERFORM pg_temp.cs_policy('{"morning_until":"23:59:59.999"}');
 PERFORM pg_temp.cs_calls(1024);
 r := pg_temp.cs_reserve('ledger', lr);
 PERFORM pg_temp.cs_assert(r ->> 'outcome' = 'reserved' AND (r ->> 'ordinal')::integer = 1025, 'ledger call 1,025 before noon: ' || r::text);
 r := pg_temp.cs_reserve('ledger', lr);
 PERFORM pg_temp.cs_assert(r ->> 'reason' = 'live_reserve_morning' AND (r ->> 'ceiling')::integer = 1025, 'the ledger''s morning line is 1,025: ' || r::text);
 b := public.context_ledger_budget();
 PERFORM pg_temp.cs_assert((b ->> 'calls_left')::integer = 0 AND b ->> 'reason' = 'live_reserve_morning', 'the budget read agrees before noon: ' || b::text);
 -- The cap line: at 1,500 the budget says cap.
 PERFORM pg_temp.cs_calls(1500);
 b := public.context_ledger_budget();
 PERFORM pg_temp.cs_assert((b ->> 'calls_left')::integer = 0 AND b ->> 'reason' = 'cap', 'the ledger budget at 1,500 calls: ' || b::text);
 -- At the default the same reads are today's: 900 all day.
 PERFORM pg_temp.cs_setting(1000);
 PERFORM pg_temp.cs_policy('{"morning_until":"00:00"}');
 PERFORM pg_temp.cs_calls(0);
 b := public.context_ledger_budget();
 PERFORM pg_temp.cs_assert((b ->> 'calls_left')::integer = 900, 'the ledger may use 900 of an empty day at the default: ' || b::text);
 PERFORM pg_temp.cs_calls(1000);
 b := public.context_ledger_budget();
 PERFORM pg_temp.cs_assert((b ->> 'calls_left')::integer = 0 AND b ->> 'reason' = 'cap', 'the ledger budget at 1,000 calls at the default: ' || b::text);
END $c$;
ROLLBACK;

-- 5. The fact reads follow a raise: a catch-up-only job stops at 1,400 calls all day and 1,025
-- before noon; a live job reads on to 1,500, and to 1,125 before noon.
BEGIN;
DO $c$
DECLARE b uuid; l uuid; c jsonb; claim jsonb; d date := pg_temp.cs_today(); st jsonb;
BEGIN
 PERFORM pg_temp.cs_lanes();
 DELETE FROM public.context_cadence_settings;
 INSERT INTO public.context_cadence_settings (id) VALUES (true);
 PERFORM pg_temp.cs_setting(1500);
 PERFORM pg_temp.cs_policy('{"morning_until":"00:00"}');   -- never morning
 b := pg_temp.cs_backlog('CS-90021'); l := pg_temp.cs_live('CS-90022');
 PERFORM pg_temp.cs_calls(1399);
 c := pg_temp.cs_cadence(b);
 PERFORM pg_temp.cs_assert((c ->> 'due')::boolean AND (c ->> 'catchup_only')::boolean, 'a catch-up-only job must be due at 1,399 calls: ' || c::text);
 PERFORM pg_temp.cs_calls(1400);
 c := pg_temp.cs_cadence(b);
 PERFORM pg_temp.cs_assert(NOT (c ->> 'due')::boolean AND c ->> 'blocked_reason' = 'backlog_budget',
  'a catch-up-only job must be held at 1,400 calls (1,500 less the day reserve of 100): ' || c::text);
 PERFORM pg_temp.cs_calls(1499);
 c := pg_temp.cs_cadence(l);
 PERFORM pg_temp.cs_assert((c ->> 'due')::boolean AND c ->> 'blocked_reason' IS NULL, 'a live job must stay due at 1,499 calls: ' || c::text);
 claim := public.claim_context_extraction_run(l, d, 'extraction');
 PERFORM pg_temp.cs_assert(claim ->> 'outcome' = 'claimed', 'a live claim at 1,499 calls: ' || claim::text);
 DELETE FROM public.context_extraction_runs WHERE job_id = l;
 PERFORM pg_temp.cs_calls(1500);
 PERFORM pg_temp.cs_assert(pg_temp.cs_cadence(l) ->> 'blocked_reason' = 'model_cap' AND pg_temp.cs_cadence(b) ->> 'blocked_reason' = 'model_cap',
  'both must be held model_cap at 1,500 calls');
 -- Before noon: the backlog stops at 1,025; a live job is due to 1,124 and paced at 1,125.
 PERFORM pg_temp.cs_policy('{"morning_until":"23:59:59.999"}');
 PERFORM pg_temp.cs_calls(1024);
 PERFORM pg_temp.cs_assert((pg_temp.cs_cadence(b) ->> 'due')::boolean, 'a catch-up-only job must be due at 1,024 calls before noon');
 PERFORM pg_temp.cs_calls(1025);
 c := pg_temp.cs_cadence(b);
 PERFORM pg_temp.cs_assert(NOT (c ->> 'due')::boolean AND c ->> 'blocked_reason' = 'backlog_budget', 'the morning backlog line is 1,025: ' || c::text);
 PERFORM pg_temp.cs_calls(1124);
 PERFORM pg_temp.cs_assert((pg_temp.cs_cadence(l) ->> 'due')::boolean, 'a live job must be due at 1,124 calls before noon');
 PERFORM pg_temp.cs_calls(1125);
 c := pg_temp.cs_cadence(l);
 PERFORM pg_temp.cs_assert(NOT (c ->> 'due')::boolean AND c ->> 'blocked_reason' = 'pacing_reserve', 'the morning cap is 1,125: ' || c::text);
 -- The status block publishes both lines and the policy it read.
 st := public.context_cadence_status();
 PERFORM pg_temp.cs_assert((st #>> '{read_reserve,backlog_ceiling_day}')::integer = 1400 AND (st #>> '{read_reserve,backlog_ceiling_morning}')::integer = 1025,
  'the cadence block''s read_reserve at 1,500: ' || (st -> 'read_reserve')::text);
 PERFORM pg_temp.cs_assert((st #>> '{policy,model_call_cap}')::integer = 1500 AND (st #>> '{policy,morning_cap}')::integer = 1125,
  'the cadence block''s policy at 1,500: ' || (st -> 'policy')::text);
 -- At the default the same job is paced at 750 and the block says 900 and 650.
 PERFORM pg_temp.cs_setting(1000);
 PERFORM pg_temp.cs_calls(749);
 PERFORM pg_temp.cs_assert((pg_temp.cs_cadence(l) ->> 'due')::boolean, 'a live job must be due at 749 calls before noon at the default');
 PERFORM pg_temp.cs_calls(750);
 PERFORM pg_temp.cs_assert(pg_temp.cs_cadence(l) ->> 'blocked_reason' = 'pacing_reserve', 'the morning cap is 750 at the default');
 st := public.context_cadence_status();
 PERFORM pg_temp.cs_assert((st #>> '{read_reserve,backlog_ceiling_day}')::integer = 900 AND (st #>> '{read_reserve,backlog_ceiling_morning}')::integer = 650
  AND (st #>> '{policy,model_call_cap}')::integer = 1000 AND (st #>> '{policy,morning_cap}')::integer = 750,
  'the cadence block at the default: ' || (st -> 'read_reserve')::text);
END $c$;
ROLLBACK;

-- 6. The heartbeat, the vision admission and the story budget read the same cap.
BEGIN;
DO $c$
DECLARE core jsonb; pipe jsonb; adm jsonb; sb jsonb;
BEGIN
 PERFORM pg_temp.cs_lanes();
 PERFORM pg_temp.cs_policy('{"morning_until":"00:00"}');   -- never morning
 DELETE FROM public.feature_flags WHERE flag_name = 'context_document_vision_v1';
 INSERT INTO public.feature_flags (flag_name, enabled, description) VALUES ('context_document_vision_v1', true, 'call cap setting contract fixture');
 DELETE FROM public.context_document_vision_settings;
 UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'context_job_story_text_v1';
 -- The default.
 PERFORM pg_temp.cs_setting(1000);
 PERFORM pg_temp.cs_calls(1000);
 core := public.context_core_status(); pipe := public.context_pipeline_status();
 PERFORM pg_temp.cs_assert((core ->> 'model_call_cap')::integer = 1000 AND (core ->> 'run_cap')::integer = 1000
  AND (pipe ->> 'model_call_cap')::integer = 1000 AND (pipe #>> '{cadence,policy,morning_cap}')::integer = 750,
  'the heartbeat must report 1,000 and 750 at the default');
 adm := public.context_document_vision_admission();
 PERFORM pg_temp.cs_assert(adm ->> 'code' = 'cap', 'the vision admission must say cap at 1,000 calls at the default: ' || adm::text);
 sb := public.context_job_story_budget();
 PERFORM pg_temp.cs_assert((sb ->> 'calls_left')::integer = 0 AND sb ->> 'reason' = 'cap', 'the story budget at 1,000 calls at the default: ' || sb::text);
 -- Raised to 1,500, the same 1,000 calls used.
 PERFORM pg_temp.cs_setting(1500);
 core := public.context_core_status(); pipe := public.context_pipeline_status();
 PERFORM pg_temp.cs_assert((core ->> 'model_call_cap')::integer = 1500 AND (core ->> 'run_cap')::integer = 1500,
  'the core status must report a cap of 1,500: ' || (core - 'coverage' - 'switches')::text);
 PERFORM pg_temp.cs_assert((pipe ->> 'model_call_cap')::integer = 1500 AND (pipe ->> 'run_cap')::integer = 1500
  AND (pipe #>> '{cadence,policy,model_call_cap}')::integer = 1500 AND (pipe #>> '{cadence,policy,morning_cap}')::integer = 1125,
  'the heartbeat must report 1,500 and 1,125');
 adm := public.context_document_vision_admission();
 PERFORM pg_temp.cs_assert(adm ->> 'code' = 'vision_reserve' AND (adm ->> 'shared_calls_ceiling')::integer = 500,
  'the vision admission at 1,000 of 1,500 is its own share, not the cap: ' || adm::text);
 sb := public.context_job_story_budget();
 PERFORM pg_temp.cs_assert((sb ->> 'calls_left')::integer = (public.context_job_story_text_policy() ->> 'calls_per_day')::integer AND sb ->> 'reason' IS NULL, 'the story budget at 1,000 of 1,500 is its own daily share: ' || sb::text);
 PERFORM pg_temp.cs_calls(1400);
 sb := public.context_job_story_budget();
 PERFORM pg_temp.cs_assert((sb ->> 'calls_left')::integer = 0 AND sb ->> 'reason' = 'live_reserve', 'the story stops at the ledger''s 1,400 line: ' || sb::text);
 PERFORM pg_temp.cs_calls(1500);
 adm := public.context_document_vision_admission();
 PERFORM pg_temp.cs_assert(adm ->> 'code' = 'cap', 'the vision admission must say cap at 1,500 calls: ' || adm::text);
 sb := public.context_job_story_budget();
 PERFORM pg_temp.cs_assert((sb ->> 'calls_left')::integer = 0 AND sb ->> 'reason' = 'cap', 'the story budget at 1,500 calls: ' || sb::text);
END $c$;
ROLLBACK;

-- 7a. The bounds and the new column.
BEGIN;
DO $c$
DECLARE c text;
BEGIN
 PERFORM pg_temp.cs_calls(0);
 INSERT INTO public.context_model_call_reservations (run_date, ordinal, phase, reserved_at) VALUES (pg_temp.cs_today(), 3000, 'bucket', now());
 BEGIN
  INSERT INTO public.context_model_call_reservations (run_date, ordinal, phase, reserved_at) VALUES (pg_temp.cs_today(), 3001, 'bucket', now());
  RAISE EXCEPTION 'call cap setting contract: a reservation numbered 3,001 was stored';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  INSERT INTO public.context_model_call_reservations (run_date, ordinal, phase, reserved_at) VALUES (pg_temp.cs_today(), 0, 'bucket', now());
  RAISE EXCEPTION 'call cap setting contract: a reservation numbered 0 was stored';
 EXCEPTION WHEN check_violation THEN NULL; END;
 UPDATE public.context_ledger_settings SET calls_per_day = 3000;
 BEGIN
  UPDATE public.context_ledger_settings SET calls_per_day = 3001;
  RAISE EXCEPTION 'call cap setting contract: calls_per_day of 3,001 was stored';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE public.context_ledger_settings SET calls_per_day = -1;
  RAISE EXCEPTION 'call cap setting contract: a negative calls_per_day was stored';
 EXCEPTION WHEN check_violation THEN NULL; END;
 -- The two reserves keep their own bound.
 FOREACH c IN ARRAY ARRAY['live_reserve_calls', 'live_reserve_calls_morning'] LOOP
  BEGIN
   EXECUTE format('UPDATE public.context_ledger_settings SET %I = 1001', c);
   RAISE EXCEPTION 'call cap setting contract: % of 1,001 was stored', c;
  EXCEPTION WHEN check_violation THEN NULL; END;
 END LOOP;
 -- read_concurrency: integer, never null, 1 unless set, 1 to 30.
 PERFORM pg_temp.cs_assert(EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'context_ledger_settings'
   AND column_name = 'read_concurrency' AND data_type = 'integer' AND is_nullable = 'NO' AND column_default = '1'),
  'read_concurrency must be integer NOT NULL DEFAULT 1');
 PERFORM pg_temp.cs_assert((SELECT read_concurrency FROM public.context_ledger_settings WHERE id) = 1, 'the settings row must read one job at a time');
 UPDATE public.context_ledger_settings SET read_concurrency = 30;
 UPDATE public.context_ledger_settings SET read_concurrency = 1;
 FOREACH c IN ARRAY ARRAY['0', '31', '-1'] LOOP
  BEGIN
   EXECUTE format('UPDATE public.context_ledger_settings SET read_concurrency = %s', c);
   RAISE EXCEPTION 'call cap setting contract: read_concurrency % was stored', c;
  EXCEPTION WHEN check_violation THEN NULL; END;
 END LOOP;
 BEGIN
  UPDATE public.context_ledger_settings SET read_concurrency = NULL;
  RAISE EXCEPTION 'call cap setting contract: a null read_concurrency was stored';
 EXCEPTION WHEN not_null_violation THEN NULL; END;
 PERFORM pg_temp.cs_assert(col_description('public.context_ledger_settings'::regclass,
   (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.context_ledger_settings'::regclass AND attname = 'read_concurrency')) LIKE '%20261013100000%',
  'read_concurrency must be commented');
 -- Nothing in the database reads it: it is the worker's.
 PERFORM pg_temp.cs_assert(NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc LIKE '%read_concurrency%'),
  'a database function reads read_concurrency');
END $c$;
ROLLBACK;

-- 7b. Shape: only the policy call moved.
DO $c$
DECLARE x record; live text; src text; masked text; extra text;
BEGIN
 -- The policy is the call budget's, untouched: same text with its first apply time masked (as the
 -- call budget's own guard reads it), immutable, and it never reads a table.
 SELECT p.prosrc, md5(regexp_replace(p.prosrc, '(''live_since'','')[^'']*('')', '\1<live_since>\2')) INTO src, masked
 FROM pg_proc p WHERE p.oid = 'public.context_cadence_policy()'::regprocedure;
 PERFORM pg_temp.cs_assert(masked = '69f9fb689b28d17679d45601e59f5b09', 'the policy body moved (masked md5 ' || masked || ')');
 PERFORM pg_temp.cs_assert((SELECT p.provolatile = 'i' AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'sql')
   FROM pg_proc p WHERE p.oid = 'public.context_cadence_policy()'::regprocedure) AND position('context_ledger_settings' IN src) = 0,
  'the policy must stay an immutable sql constant');
 -- The wrapper: stable, definer, fixed search_path, service role only.
 PERFORM pg_temp.cs_assert((SELECT p.provolatile = 's' AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public, pg_temp']
   AND p.prorettype = 'jsonb'::regtype AND p.pronargs = 0 FROM pg_proc p WHERE p.oid = 'public.context_cadence_policy_today()'::regprocedure),
  'the wrapper must be STABLE SECURITY DEFINER with a fixed search_path, returning jsonb');
 PERFORM pg_temp.cs_assert(obj_description('public.context_cadence_policy_today()'::regprocedure, 'pg_proc') LIKE 'Call cap setting (20261013100000)%',
  'the wrapper must be commented');
 -- The seven readers: this migration's bodies; with the one name put back each is the body it
 -- replaced, so nothing but the policy call changed; volatility, definer and grants as before.
 FOR x IN SELECT * FROM (VALUES
  ('public.reserve_context_model_call(text,uuid,uuid)', 'e381963e14d214b6b43c98eb70836919', '25a5b5f208af726d47e952f98cecef56', 'v', 1),
  ('public.context_ledger_budget()', 'e1342d1e088674c8e47ae4d2af317c6e', '8f7b42529db2e1062283de005cef01a7', 'v', 1),
  ('public.context_jobs_cadence(uuid[])', '9750d24f7d8d79e05018c2b2f9e3781c', 'c711479690d167f09d016f0413f11160', 's', 1),
  ('public.context_document_vision_admission()', '6fc6fbe5e932885a6105d462932ee5bb', 'f1d33b0f0ee54516941ee313cb7fe756', 's', 1),
  ('public.context_job_story_budget()', '7a54f0abc1b11389181ccc6664dd0e34', 'bd32ab0faece36527b05abdce0474f47', 'v', 1),
  ('public.context_cadence_status()', 'ddcd452a67e9e15150ac05d7847e655f', '85e60d754e65b812b28e798435e2a5a4', 's', 1),
  ('public.context_core_status()', '07c51159715c91663a1038f01bf6e09c', '2b6b2c54daeae381cdeff7802d72df81', 's', 2)
 ) AS t(sig, want, before, volatility, calls) LOOP
  -- The later recheck removes only the retired today_pass key.
  SELECT replace(prosrc, 'to_jsonb(p)-''attribution_done_at''', 'to_jsonb(p)') INTO src FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  PERFORM pg_temp.cs_assert(md5(src) = x.want, format('%s md5 %s is not this migration''s', x.sig, md5(src)));
  PERFORM pg_temp.cs_assert(md5(replace(src, 'public.context_cadence_policy_today()', 'public.context_cadence_policy()')) = x.before,
   format('%s differs from the body it replaced beyond the policy call', x.sig));
  PERFORM pg_temp.cs_assert((length(src) - length(replace(src, 'public.context_cadence_policy_today()', ''))) / length('public.context_cadence_policy_today()') = x.calls
   AND position('context_cadence_policy()' IN src) = 0, format('%s must read the policy through the wrapper only, %s time(s)', x.sig, x.calls));
  PERFORM pg_temp.cs_assert((SELECT p.provolatile::text = x.volatility AND p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig)),
   format('%s volatility or definer moved', x.sig));
  PERFORM pg_temp.cs_assert(NOT has_function_privilege('anon', x.sig, 'EXECUTE') AND NOT has_function_privilege('authenticated', x.sig, 'EXECUTE')
   AND has_function_privilege('service_role', x.sig, 'EXECUTE'), x.sig || ' grants');
 END LOOP;
 PERFORM pg_temp.cs_assert(NOT has_function_privilege('anon', 'public.context_cadence_policy_today()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.context_cadence_policy_today()', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.context_cadence_policy_today()', 'EXECUTE'), 'the wrapper''s grants');
 -- No other function reads either cap.
 SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO extra
 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_temp' AND p.prosrc ~ '(model_call_cap|morning_cap)'
  AND p.oid::regprocedure::text NOT IN ('context_cadence_policy()', 'context_cadence_policy_today()', 'reserve_context_model_call(text,uuid,uuid)',
   'context_ledger_budget()', 'context_jobs_cadence(uuid[])', 'context_document_vision_admission()', 'context_job_story_budget()',
   'context_cadence_status()', 'context_core_status()');
 PERFORM pg_temp.cs_assert(extra IS NULL, 'another function reads a cap: ' || coalesce(extra, ''));
 -- The CHECKs, exactly.
 PERFORM pg_temp.cs_assert((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.context_model_call_reservations'::regclass
   AND conname = 'context_model_call_reservations_ordinal_check' AND convalidated) = 'CHECK (((ordinal >= 1) AND (ordinal <= 3000)))', 'the ordinal check');
 PERFORM pg_temp.cs_assert((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.context_ledger_settings'::regclass
   AND conname = 'context_ledger_settings_calls_per_day_check' AND convalidated) = 'CHECK (((calls_per_day >= 0) AND (calls_per_day <= 3000)))', 'the calls_per_day check');
 PERFORM pg_temp.cs_assert((SELECT count(*) FROM pg_constraint WHERE contype = 'c' AND (
   (conrelid = 'public.context_model_call_reservations'::regclass AND pg_get_constraintdef(oid) LIKE '%ordinal%')
   OR (conrelid = 'public.context_ledger_settings'::regclass AND pg_get_constraintdef(oid) LIKE '%calls_per_day%'))) = 2, 'a bound was doubled');
 PERFORM pg_temp.cs_assert(obj_description('public.context_ledger_settings'::regclass, 'pg_class') LIKE '%0 to 3000%'
  AND obj_description('public.context_ledger_settings'::regclass, 'pg_class') LIKE '%context_cadence_policy_today%'
  AND strpos(obj_description('public.context_ledger_settings'::regclass, 'pg_class'), chr(8212)) = 0, 'the settings comment must state what calls_per_day now does');
END $c$;
