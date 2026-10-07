-- Contract for 20261007040000_context_scorecard_hourly: the hourly scorecard
-- run. The recorder runs the scorecard and stores every run, a failed,
-- timed-out or unreadable one as a failed run with its code, and writes no
-- other table (no ai_alerts row, nothing any agent or screen reads); the status
-- read says what the hourly reader passes on (red rows, a failing streak since
-- when, or no run for 75 minutes) and grades the hourly run as a row 10 lane
-- that is green only while a reader named in the policy (rayleigh) has recorded
-- a receipt in the last 75 minutes; the receipt is refused for an unnamed
-- reader, a run that is not the newest, or red rows that are not the newest ok
-- run's; the job is scheduled from the policy and re-applies once; the rollback
-- unschedules and drops, and refuses while the scorecard reads the status.
-- Every fixture is synthetic and rolled back; a pg_cron stand-in lives only
-- inside its transaction. The status read is graded at pinned instants
-- (p_as_of); the recorder and the receipt use now() of their transaction and
-- only facts relative to it are asserted.

-- Writes made so far in this transaction, per table, and the tables written
-- since such a snapshot (pg_stat_xact_user_tables counts every insert, update
-- and delete of the transaction, inside functions and failed subtransactions
-- too). Session-local helpers, gone when this session ends.
CREATE FUNCTION pg_temp.hourly_writes() RETURNS jsonb LANGUAGE sql VOLATILE AS $$
 SELECT coalesce(jsonb_object_agg(s.schemaname || '.' || s.relname, s.n_tup_ins + s.n_tup_upd + s.n_tup_del), '{}'::jsonb)
 FROM pg_stat_xact_user_tables s
 WHERE s.schemaname !~ '^pg_temp' AND s.n_tup_ins + s.n_tup_upd + s.n_tup_del > 0
$$;
CREATE FUNCTION pg_temp.hourly_written_since(p_before jsonb) RETURNS text[] LANGUAGE sql VOLATILE AS $$
 SELECT coalesce(array_agg(w.k ORDER BY w.k COLLATE "C"), '{}')
 FROM jsonb_each_text(pg_temp.hourly_writes()) AS w(k, v)
 WHERE w.v::bigint > coalesce((p_before->>w.k)::bigint, 0)
$$;
-- 14 rows, the given ones red, as a run's row_status.
CREATE FUNCTION pg_temp.hourly_row_status(p_red integer[]) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_agg(jsonb_build_object('row', g, 'stage', 'Stage ' || g, 'status', CASE WHEN g = ANY (p_red) THEN 'red' ELSE 'green' END,
   'red_lanes', '[]'::jsonb, 'amber_lanes', '[]'::jsonb) ORDER BY g)
 FROM generate_series(1, 14) g
$$;

-- 0. No pg_cron in the registered stack, so the migration scheduled nothing,
--    and no stand-in outlived an earlier contract.
DO $$
BEGIN
 IF to_regclass('cron.job') IS NOT NULL THEN
  RAISE EXCEPTION 'hourly contract: a cron.job stand-in outlived its transaction';
 END IF;
 IF EXISTS (SELECT 1 FROM public.context_scorecard_runs) OR EXISTS (SELECT 1 FROM public.context_scorecard_receipts) THEN
  RAISE EXCEPTION 'hourly contract: rows left behind before the contract';
 END IF;
END $$;

-- 1. Shape and access; the bodies write only the migration's own two tables.
DO $shape$
DECLARE f text; p record; t text; targets text[];
BEGIN
 FOR p IN SELECT pr.oid::regprocedure::text AS sig, pr.prosecdef, pr.proconfig
          FROM pg_proc pr WHERE pr.oid IN ('public.context_scorecard_record_run(text)'::regprocedure,
                                           'public.context_scorecard_record_receipt(text,bigint,integer[])'::regprocedure,
                                           'public.context_scorecard_run_status(timestamptz)'::regprocedure) LOOP
  IF NOT p.prosecdef OR NOT ('search_path=public, pg_temp' = ANY (p.proconfig)) THEN
   RAISE EXCEPTION 'hourly contract: % must be SECURITY DEFINER with search_path public, pg_temp', p.sig;
  END IF;
 END LOOP;
 IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.context_scorecard_record_run(text)'::regprocedure) <> 'v'
    OR (SELECT provolatile FROM pg_proc WHERE oid = 'public.context_scorecard_record_receipt(text,bigint,integer[])'::regprocedure) <> 'v'
    OR (SELECT provolatile FROM pg_proc WHERE oid = 'public.context_scorecard_run_status(timestamptz)'::regprocedure) <> 's'
    OR (SELECT provolatile FROM pg_proc WHERE oid = 'public.context_scorecard_run_policy()'::regprocedure) <> 'i' THEN
  RAISE EXCEPTION 'hourly contract: volatility wrong (recorder and receipt volatile, status stable, policy immutable)';
 END IF;
 FOREACH f IN ARRAY ARRAY['public.context_scorecard_run_policy()', 'public.context_scorecard_record_run(text)',
   'public.context_scorecard_record_receipt(text,bigint,integer[])', 'public.context_scorecard_run_status(timestamptz)'] LOOP
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
     OR has_function_privilege('public', f, 'EXECUTE') OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
   RAISE EXCEPTION 'hourly contract: % access wrong', f;
  END IF;
  IF obj_description(to_regprocedure(f), 'pg_proc') NOT LIKE 'Context scorecard hourly (20261007040000)%' THEN
   RAISE EXCEPTION 'hourly contract: % comment does not name the migration', f;
  END IF;
  -- No outside effect: nothing names the ops alert table, and every insert,
  -- update, delete or truncate targets the run log or the receipts.
  IF position('ai_alerts' IN (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(f))) > 0 THEN
   RAISE EXCEPTION 'hourly contract: % names ai_alerts', f;
  END IF;
  SELECT coalesce(array_agg(DISTINCT lower(m[2]) ORDER BY lower(m[2])), '{}') INTO targets
  FROM pg_proc pr CROSS JOIN LATERAL regexp_matches(regexp_replace(pr.prosrc, '--[^\n]*', '', 'g'),
    '\m(insert\s+into|update|delete\s+from|truncate)\s+([a-z_][a-z0-9_.]*)', 'gi') AS m
  WHERE pr.oid = to_regprocedure(f);
  IF NOT targets <@ ARRAY['public.context_scorecard_runs', 'public.context_scorecard_receipts'] THEN
   RAISE EXCEPTION 'hourly contract: % writes outside its own tables: %', f, targets;
  END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['public.context_scorecard_runs', 'public.context_scorecard_receipts'] LOOP
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass)
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname || '.' || tablename = t)
     OR has_table_privilege('anon', t, 'SELECT') OR has_table_privilege('authenticated', t, 'SELECT')
     OR has_table_privilege('anon', t, 'TRUNCATE') OR has_table_privilege('authenticated', t, 'TRUNCATE')
     OR NOT has_table_privilege('service_role', t, 'SELECT')
     OR has_table_privilege('service_role', t, 'INSERT') OR has_table_privilege('service_role', t, 'UPDATE')
     OR has_table_privilege('service_role', t, 'DELETE') OR has_table_privilege('service_role', t, 'TRUNCATE') THEN
   RAISE EXCEPTION 'hourly contract: % access wrong (RLS on, no policy, service_role read only)', t;
  END IF;
  IF obj_description(t::regclass, 'pg_class') NOT LIKE 'Context scorecard hourly (20261007040000)%' THEN
   RAISE EXCEPTION 'hourly contract: % comment does not name the migration', t;
  END IF;
 END LOOP;
 -- Text that is compared or ordered sorts in C order.
 IF (SELECT string_agg(a.attrelid::regclass::text || '.' || a.attname || ':' || c.collname, ',' ORDER BY a.attrelid::regclass::text COLLATE "C", a.attname COLLATE "C")
     FROM pg_attribute a JOIN pg_collation c ON c.oid = a.attcollation
     WHERE (a.attrelid, a.attname) IN (('public.context_scorecard_runs'::regclass, 'red_lanes'),
                                       ('public.context_scorecard_receipts'::regclass, 'reader'),
                                       ('public.context_scorecard_receipts'::regclass, 'kind')))
    IS DISTINCT FROM 'context_scorecard_receipts.kind:C,context_scorecard_receipts.reader:C,context_scorecard_runs.red_lanes:C' THEN
  RAISE EXCEPTION 'hourly contract: red_lanes, reader and kind must be COLLATE "C"';
 END IF;
 -- A receipt goes with its run.
 IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.context_scorecard_receipts'::regclass AND c.contype = 'f'
                AND c.confrelid = 'public.context_scorecard_runs'::regclass AND c.confdeltype = 'c') THEN
  RAISE EXCEPTION 'hourly contract: a receipt must reference its run and be deleted with it';
 END IF;
END $shape$;

-- 2. The policy: every number of the hourly run, the job's command built from
--    them, and the report: this read, the readers whose receipts count, 75 min.
DO $policy$
DECLARE pol jsonb := public.context_scorecard_run_policy();
BEGIN
 IF pol->>'cron_job' IS DISTINCT FROM 'context-scorecard-hourly' OR pol->>'schedule' IS DISTINCT FROM '40 * * * *'
    OR pol->>'statement_timeout' IS DISTINCT FROM '60s' OR pol->>'lock_timeout' IS DISTINCT FROM '10s'
    OR pol->>'command' IS DISTINCT FROM format('SET statement_timeout = %L; SET lock_timeout = %L; SELECT public.context_scorecard_record_run(%L)',
         pol->>'statement_timeout', pol->>'lock_timeout', 'cron')
    OR (pol->>'late_after_minutes')::integer <> 75 OR (pol->>'window_hours')::integer <> 24
    OR (pol->'missed_hours'->>'green')::integer <> 0 OR (pol->'missed_hours'->>'amber')::integer <> 1
    OR (pol->>'slow_after_ms')::integer <> 30000 OR (pol->>'keep_days')::integer <> 180
    OR pol->'report' IS DISTINCT FROM '{"surface": "context_scorecard_run_status", "readers": ["rayleigh"], "receipt_fresh_minutes": 75}'::jsonb THEN
  RAISE EXCEPTION 'hourly contract: policy wrong: %', pol;
 END IF;
 -- The run's own limit stays under the server's 120 s and far above the measured 1.24 s.
 IF extract(epoch FROM (pol->>'statement_timeout')::interval) NOT BETWEEN 10 AND 110
    OR (pol->>'slow_after_ms')::numeric >= extract(epoch FROM (pol->>'statement_timeout')::interval) * 1000 THEN
  RAISE EXCEPTION 'hourly contract: statement timeout or slow limit out of range: %', pol;
 END IF;
END $policy$;

-- 3. A real run: the recorder runs the registered scorecard, stores what it
--    said and writes nothing else; the status says what to pass on and reads
--    red until the reader's receipt; the receipt writes only its own table.
BEGIN;
DO $real$
DECLARE r jsonb; run public.context_scorecard_runs; card jsonb; before jsonb; w text[]; s jsonb; rc jsonb; msg text;
BEGIN
 -- The card as the recorder will see it (same instant, nothing written yet).
 card := public.context_scorecard(now());
 before := pg_temp.hourly_writes();
 r := public.context_scorecard_record_run('manual');
 w := pg_temp.hourly_written_since(before);
 IF w IS DISTINCT FROM ARRAY['public.context_scorecard_runs'] THEN
  RAISE EXCEPTION 'hourly contract: a run wrote outside its own table: %', w;
 END IF;
 SELECT * INTO run FROM public.context_scorecard_runs WHERE id = (r->>'run_id')::bigint;
 IF run.id IS NULL OR run.status <> 'ok' OR run.error_code IS NOT NULL OR run.run_trigger <> 'manual' OR run.as_of <> now()
    OR run.finished_at < run.started_at OR r->>'status' <> 'ok' OR (r->>'duration_ms')::integer <> run.duration_ms
    OR r ? 'report' OR (r->>'pruned')::integer <> 0 THEN
  RAISE EXCEPTION 'hourly contract: a real run was not stored as ok: % %', r, row_to_json(run);
 END IF;
 IF run.scorecard_version IS DISTINCT FROM card->>'version' OR run.summary IS DISTINCT FROM card->'summary'
    OR run.live_jobs IS DISTINCT FROM (card->>'live_jobs')::integer OR run.alarms IS DISTINCT FROM card->'alarms' THEN
  RAISE EXCEPTION 'hourly contract: the run does not hold the scorecard''s version, summary, live jobs and alarms';
 END IF;
 IF jsonb_array_length(run.row_status) <> jsonb_array_length(card->'rows')
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(card->'rows') c
               WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(run.row_status) rs
                                 WHERE (rs->>'row')::integer = (c->>'row')::integer AND rs->>'status' = c->>'status' AND rs->>'stage' = c->>'stage'))
    OR run.red_rows <> ARRAY(SELECT (c->>'row')::integer FROM jsonb_array_elements(card->'rows') c WHERE c->>'status' = 'red' ORDER BY 1)
    OR run.red_lanes <> ARRAY(SELECT (c.v->>'row') || ':' || (l.v->>'lane')
                              FROM jsonb_array_elements(card->'rows') WITH ORDINALITY AS c(v, o)
                              CROSS JOIN LATERAL jsonb_array_elements(c.v->'lanes') WITH ORDINALITY AS l(v, o)
                              WHERE l.v->>'status' = 'red' ORDER BY (c.v->>'row')::integer, c.o, l.o)
    OR jsonb_array_length(run.red_lane_values) <> cardinality(run.red_lanes) THEN
  RAISE EXCEPTION 'hourly contract: row statuses, red rows or red lanes differ from the scorecard: % %', run.red_rows, run.red_lanes;
 END IF;
 -- What the reader is told to pass on: the run's red rows in one line, or nothing when none is red.
 s := public.context_scorecard_run_status(now());
 msg := CASE WHEN cardinality(run.red_rows) = 0 THEN NULL
   ELSE format('Context system hourly check: %s of %s rows red at %s Perth on %s (rows %s).', cardinality(run.red_rows),
     jsonb_array_length(run.row_status), to_char(now() AT TIME ZONE 'Australia/Perth', 'HH24:MI'),
     to_char(now() AT TIME ZONE 'Australia/Perth', 'FMDD Mon'), array_to_string(run.red_rows, ', ')) END;
 IF s->'report'->>'kind' IS DISTINCT FROM (CASE WHEN cardinality(run.red_rows) = 0 THEN 'all_clear' ELSE 'red_rows' END)
    OR s->'report'->>'message' IS DISTINCT FROM msg OR (s->'report'->>'run_id')::bigint <> run.id
    OR s->'report'->'red_rows' <> to_jsonb(run.red_rows) OR (s->'report'->>'reported')::boolean OR s->'report'->'receipt' <> 'null'::jsonb
    OR s->'report'->>'surface' <> 'context_scorecard_run_status' OR s->'report'->'readers' <> '["rayleigh"]' THEN
  RAISE EXCEPTION 'hourly contract: the status does not say what to pass on for a real run: %', s->'report';
 END IF;
 -- Nobody has received it yet: the lane says so (it is also red here because the stack has no pg_cron).
 IF s->'lane'->>'status' <> 'red' OR position('red rows reported to no reader: no receipt from rayleigh yet' IN s->'lane'->>'note') = 0 THEN
  RAISE EXCEPTION 'hourly contract: a run nobody received did not read as reported to no reader: %', s->'lane';
 END IF;
 IF coalesce(s->'report'->>'message', '') ~ '[\u2014\u2013]' OR s->'lane'->>'note' ~ '[\u2014\u2013]' OR s->'lane'->>'value' ~ '[\u2014\u2013]' THEN
  RAISE EXCEPTION 'hourly contract: staff-facing words carry an em or en dash';
 END IF;
 -- The reader passes it on and records its receipt: only the receipts are written.
 before := pg_temp.hourly_writes();
 rc := public.context_scorecard_record_receipt('rayleigh', (s->'report'->>'run_id')::bigint,
   ARRAY(SELECT jsonb_array_elements_text(s->'report'->'red_rows')::integer));
 w := pg_temp.hourly_written_since(before);
 IF w IS DISTINCT FROM ARRAY['public.context_scorecard_receipts'] THEN
  RAISE EXCEPTION 'hourly contract: a receipt wrote outside its own table: %', w;
 END IF;
 s := public.context_scorecard_run_status(now());
 IF rc->>'kind' IS DISTINCT FROM s->'report'->>'kind' OR NOT (s->'report'->>'reported')::boolean
    OR (s->'report'->'receipt'->>'id')::bigint <> (rc->>'receipt_id')::bigint OR s->'report'->'receipt'->>'reader' <> 'rayleigh'
    OR position('reported to no reader' IN s->'lane'->>'note') > 0 THEN
  RAISE EXCEPTION 'hourly contract: a receipt did not count as reported: % %', rc, s->'report';
 END IF;
END $real$;
ROLLBACK;

-- 4. A scorecard that fails, times out or answers in an unreadable shape is a
--    failed run with its code, never a lost hour; the status reports the
--    failing streak, since when and with which code, refreshed run by run.
BEGIN;
CREATE OR REPLACE FUNCTION public.context_scorecard(p_as_of timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$ BEGIN RAISE EXCEPTION 'hourly stub: scorecard broken' USING ERRCODE = 'XX000'; END $$;
DO $fail$
DECLARE r jsonb; run public.context_scorecard_runs; before jsonb; w text[]; s jsonb; since text;
BEGIN
 before := pg_temp.hourly_writes();
 r := public.context_scorecard_record_run('cron');
 w := pg_temp.hourly_written_since(before);
 SELECT * INTO run FROM public.context_scorecard_runs WHERE id = (r->>'run_id')::bigint;
 IF run.id IS NULL THEN RAISE EXCEPTION 'hourly contract: a failed scorecard left no run'; END IF;
 IF run.status <> 'failed' OR run.error_code <> 'XX000' OR run.run_trigger <> 'cron' OR run.summary IS NOT NULL OR run.row_status IS NOT NULL
    OR cardinality(run.red_rows) <> 0 OR r->>'status' <> 'failed' OR r->>'error_code' <> 'XX000' THEN
  RAISE EXCEPTION 'hourly contract: a failed scorecard was stored wrong: %', row_to_json(run);
 END IF;
 IF w IS DISTINCT FROM ARRAY['public.context_scorecard_runs'] THEN
  RAISE EXCEPTION 'hourly contract: a failed run wrote outside its own table: %', w;
 END IF;
 -- The failure is reported, not silent: one message, since when, which code.
 since := to_char(now() AT TIME ZONE 'Australia/Perth', 'HH24:MI') || ' Perth on ' || to_char(now() AT TIME ZONE 'Australia/Perth', 'FMDD Mon');
 s := public.context_scorecard_run_status(now());
 IF s->'report'->>'kind' IS DISTINCT FROM 'failing'
    OR s->'report'->>'message' IS DISTINCT FROM format('Context system hourly check failing since %s (XX000): 1 failed run. No good run is stored yet.', since)
    OR (s->'report'->>'failing_since')::timestamptz <> now() OR (s->'report'->>'run_id')::bigint <> run.id OR s->'report'->'red_rows' <> '[]'
    OR s->'lane'->>'status' <> 'red' OR position('the newest run failed (XX000), 1 in a row' IN s->'lane'->>'note') = 0 THEN
  RAISE EXCEPTION 'hourly contract: a failing run gave the reader nothing to pass on: %', s->'report';
 END IF;
END $fail$;
-- Unreadable shapes: no rows; a row status outside green, amber and red; no version.
CREATE OR REPLACE FUNCTION public.context_scorecard(p_as_of timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE sql STABLE AS $$ SELECT '{"version": "x", "summary": {}, "rows": []}'::jsonb $$;
DO $$ BEGIN
 IF public.context_scorecard_record_run('manual')->>'error_code' IS DISTINCT FROM 'card_shape' THEN
  RAISE EXCEPTION 'hourly contract: a card with no rows was not card_shape';
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.context_scorecard(p_as_of timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE sql STABLE AS $$ SELECT '{"version": "x", "summary": {}, "rows": [{"row": 1, "status": "purple", "lanes": []}]}'::jsonb $$;
DO $$ BEGIN
 IF public.context_scorecard_record_run('manual')->>'error_code' IS DISTINCT FROM 'card_shape' THEN
  RAISE EXCEPTION 'hourly contract: a row status outside green, amber and red was not card_shape';
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.context_scorecard(p_as_of timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE sql STABLE AS $$ SELECT '{"summary": {}, "rows": [{"row": 1, "status": "red", "lanes": []}]}'::jsonb $$;
DO $$
DECLARE s jsonb;
BEGIN
 IF public.context_scorecard_record_run('manual')->>'error_code' IS DISTINCT FROM 'card_shape' THEN
  RAISE EXCEPTION 'hourly contract: a card with no version was not card_shape';
 END IF;
 IF (SELECT count(*) FROM public.context_scorecard_runs WHERE status = 'failed') <> 4 THEN
  RAISE EXCEPTION 'hourly contract: expected four failed runs';
 END IF;
 -- The report is refreshed while the failures last: same start, newest code, the count.
 s := public.context_scorecard_run_status(now());
 IF s->'report'->>'kind' IS DISTINCT FROM 'failing' OR (s->'report'->>'failing_since')::timestamptz <> now()
    OR s->'report'->>'message' NOT LIKE 'Context system hourly check failing since % Perth on % (card_shape): 4 failed runs in a row. No good run is stored yet.'
    OR (s->>'consecutive_failures')::integer <> 4 THEN
  RAISE EXCEPTION 'hourly contract: the failing report was not refreshed: %', s->'report';
 END IF;
END $$;
-- A scorecard cut by the statement timeout (the job's own limit) is stored as
-- 57014 and the call still returns: the timer fires once per statement.
CREATE OR REPLACE FUNCTION public.context_scorecard(p_as_of timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE sql VOLATILE AS $$ SELECT pg_sleep(3); SELECT '{}'::jsonb $$;
SET LOCAL statement_timeout = '300ms';
SELECT (public.context_scorecard_record_run('cron')->>'error_code') = '57014' AS hourly_timeout_stored \gset
SET LOCAL statement_timeout = 0;
\if :hourly_timeout_stored
\else
DO $$ BEGIN RAISE EXCEPTION 'hourly contract: a statement timeout in the scorecard was not stored as 57014'; END $$;
\endif
DO $$
DECLARE rc jsonb; s jsonb;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.context_scorecard_runs WHERE status = 'failed' AND error_code = '57014' AND run_trigger = 'cron'
                AND duration_ms BETWEEN 200 AND 2900) THEN
  RAISE EXCEPTION 'hourly contract: the timed-out run row is missing or its duration is wrong';
 END IF;
 -- A failed newest run can be receipted too (the reader passed the failure on); it stays red.
 rc := public.context_scorecard_record_receipt('rayleigh', (public.context_scorecard_run_status(now())->'report'->>'run_id')::bigint, '{}');
 s := public.context_scorecard_run_status(now());
 IF rc->>'kind' IS DISTINCT FROM 'failing' OR s->'lane'->>'status' <> 'red' OR NOT (s->'report'->>'reported')::boolean THEN
  RAISE EXCEPTION 'hourly contract: a receipt of a failing run was not kept as failing, or the failed run stopped reading red: % %', rc, s->'lane';
 END IF;
END $$;
-- The trigger is cron or manual, nothing else: a reader records a receipt, never a run.
DO $$ BEGIN
 PERFORM public.context_scorecard_record_run(NULL);
 RAISE EXCEPTION 'hourly contract: a null trigger was accepted';
EXCEPTION WHEN invalid_parameter_value THEN NULL;
END $$;
DO $$ BEGIN
 PERFORM public.context_scorecard_record_run('rayleigh');
 RAISE EXCEPTION 'hourly contract: an unknown trigger was accepted';
EXCEPTION WHEN invalid_parameter_value THEN NULL;
END $$;
ROLLBACK;

-- 4b. The job's timeout firing late (after the scorecard answered) still
--     leaves the hour stored: cut while storing the card, the hour is a failed
--     run with the code; cut in the keep window, the run stands and the next
--     run prunes.
BEGIN;
CREATE OR REPLACE FUNCTION public.context_scorecard(p_as_of timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE sql STABLE AS $$
 SELECT '{"version": "x", "summary": {}, "rows": [{"row": 4, "stage": "Four", "status": "red",
          "lanes": [{"lane": "slow_lane", "status": "red", "number": 1, "unit": "u", "value": "1 u"}]}]}'::jsonb
$$;
CREATE FUNCTION public.hourly_contract_slow() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_sleep(1); IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$;
CREATE TRIGGER hourly_contract_slow BEFORE INSERT ON public.context_scorecard_runs FOR EACH ROW EXECUTE FUNCTION public.hourly_contract_slow();
SET LOCAL statement_timeout = '300ms';
WITH x AS MATERIALIZED (SELECT public.context_scorecard_record_run('manual') AS r)
SELECT x.r->>'status' = 'failed' AND x.r->>'error_code' = '57014' AND (x.r->>'duration_ms')::integer < 300 AS hourly_late_store_ok FROM x \gset
SET LOCAL statement_timeout = 0;
\if :hourly_late_store_ok
\else
DO $$ BEGIN RAISE EXCEPTION 'hourly contract: a timeout while storing the card lost the hour or its code'; END $$;
\endif
DO $$ BEGIN
 IF (SELECT count(*) FROM public.context_scorecard_runs WHERE status = 'failed' AND error_code = '57014') <> 1 THEN
  RAISE EXCEPTION 'hourly contract: the hour cut while storing the card is not one failed run';
 END IF;
END $$;
DROP TRIGGER hourly_contract_slow ON public.context_scorecard_runs;
INSERT INTO public.context_scorecard_runs (run_trigger, as_of, started_at, finished_at, duration_ms, status, error_code)
VALUES ('cron', now() - interval '181 days', now() - interval '181 days', now() - interval '181 days', 0, 'failed', '57014');
CREATE TRIGGER hourly_contract_slow BEFORE DELETE ON public.context_scorecard_runs FOR EACH ROW EXECUTE FUNCTION public.hourly_contract_slow();
SET LOCAL statement_timeout = '300ms';
WITH x AS MATERIALIZED (SELECT public.context_scorecard_record_run('manual') AS r)
SELECT x.r->>'status' = 'ok' AND x.r->>'prune_skipped_code' = '57014' AND (x.r->>'pruned')::integer = 0 AS hourly_late_prune_ok FROM x \gset
SET LOCAL statement_timeout = 0;
\if :hourly_late_prune_ok
\else
DO $$ BEGIN RAISE EXCEPTION 'hourly contract: a timeout in the keep window lost the run'; END $$;
\endif
DO $$ BEGIN
 IF (SELECT count(*) FROM public.context_scorecard_runs WHERE status = 'ok' AND red_rows = '{4}') <> 1
    OR NOT EXISTS (SELECT 1 FROM public.context_scorecard_runs WHERE as_of = now() - interval '181 days') THEN
  RAISE EXCEPTION 'hourly contract: the run cut in its keep window is not stored, or the old run was deleted anyway';
 END IF;
END $$;
ROLLBACK;

-- 5. The receipt, run by run, on fixed cards: only a named reader, only the
--    newest run, only the newest ok run's red rows; the kind says what it was.
BEGIN;
CREATE TEMP TABLE hourly_card (card jsonb) ON COMMIT DROP;
CREATE FUNCTION pg_temp.hourly_card_for(p_red integer[], p_amber integer[] DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('version', 'context-scorecard-v1', 'as_of', now(), 'live_jobs', 3,
  'summary', jsonb_build_object('done', cardinality(p_red) + cardinality(p_amber) = 0, 'red', cardinality(p_red), 'red_rows', to_jsonb(p_red)),
  'rows', (SELECT jsonb_agg(jsonb_build_object('row', g, 'stage', 'Stage ' || g, 'status', s.st,
            'lanes', jsonb_build_array(
              jsonb_build_object('lane', 'other_' || g, 'status', 'green', 'number', 0, 'unit', 'things', 'value', 'none'),
              jsonb_build_object('lane', 'lane_' || g, 'status', s.st, 'number', g, 'unit', 'things', 'value', g || ' things')))
           ORDER BY g)
           FROM generate_series(1, 14) g CROSS JOIN LATERAL (SELECT CASE WHEN g = ANY (p_red) THEN 'red'
             WHEN g = ANY (p_amber) THEN 'amber' ELSE 'green' END AS st) s),
  'alarms', jsonb_build_array(jsonb_build_object('key', 'lane_quiet', 'row', 1)))
$$;
CREATE OR REPLACE FUNCTION public.context_scorecard(p_as_of timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE sql STABLE AS $$ SELECT card FROM pg_temp.hourly_card $$;
CREATE FUNCTION pg_temp.hourly_run(p_red integer[], p_amber integer[] DEFAULT '{}') RETURNS bigint LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM pg_temp.hourly_card;
 INSERT INTO pg_temp.hourly_card VALUES (pg_temp.hourly_card_for(p_red, p_amber));
 RETURN (public.context_scorecard_record_run('manual')->>'run_id')::bigint;
END $$;
CREATE FUNCTION pg_temp.hourly_refused(p_reader text, p_run bigint, p_rows integer[]) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 PERFORM public.context_scorecard_record_receipt(p_reader, p_run, p_rows);
 RETURN false;
EXCEPTION WHEN invalid_parameter_value THEN RETURN true;
END $$;
DO $receipt$
DECLARE run1 bigint; run2 bigint; run3 bigint; run4 bigint; run5 bigint; rc jsonb; before jsonb; w text[]; stored public.context_scorecard_receipts;
BEGIN
 -- a. No run is stored: nothing to receipt.
 IF NOT pg_temp.hourly_refused('rayleigh', 1, '{}') THEN
  RAISE EXCEPTION 'hourly contract: a receipt with no run stored was accepted';
 END IF;
 run1 := pg_temp.hourly_run('{2,5}');
 -- b. Only a reader the policy names; a list of rows, never null or holding a null.
 IF NOT pg_temp.hourly_refused('jarvis', run1, '{2,5}') OR NOT pg_temp.hourly_refused(NULL, run1, '{2,5}')
    OR NOT pg_temp.hourly_refused('rayleigh', run1, NULL) OR NOT pg_temp.hourly_refused('rayleigh', run1, ARRAY[2, NULL]) THEN
  RAISE EXCEPTION 'hourly contract: a receipt from an unnamed reader or without its red rows was accepted';
 END IF;
 -- c. Only the newest run's own red rows, and only the newest run.
 IF NOT pg_temp.hourly_refused('rayleigh', run1, '{2}') OR NOT pg_temp.hourly_refused('rayleigh', run1, '{2,5,7}')
    OR NOT pg_temp.hourly_refused('rayleigh', run1 + 1000, '{2,5}') OR NOT pg_temp.hourly_refused('rayleigh', NULL, '{2,5}') THEN
  RAISE EXCEPTION 'hourly contract: a receipt for other red rows or another run was accepted';
 END IF;
 IF EXISTS (SELECT 1 FROM public.context_scorecard_receipts) THEN
  RAISE EXCEPTION 'hourly contract: a refused receipt was stored';
 END IF;
 -- d. The right receipt (rows in any order, repeated) is stored as passed on, and writes only its own table.
 before := pg_temp.hourly_writes();
 rc := public.context_scorecard_record_receipt('rayleigh', run1, '{5,2,2}');
 w := pg_temp.hourly_written_since(before);
 SELECT * INTO stored FROM public.context_scorecard_receipts WHERE id = (rc->>'receipt_id')::bigint;
 IF w IS DISTINCT FROM ARRAY['public.context_scorecard_receipts'] OR rc->>'kind' <> 'red_rows' OR rc->'red_rows' <> '[2, 5]'
    OR (rc->>'run_id')::bigint <> run1 OR rc->>'reader' <> 'rayleigh' OR (rc->>'received_at')::timestamptz <> now()
    OR stored.run_id <> run1 OR stored.reader <> 'rayleigh' OR stored.received_at <> now() OR stored.kind <> 'red_rows' OR stored.red_rows <> '{2,5}' THEN
  RAISE EXCEPTION 'hourly contract: the receipt was not stored as passed on: % % %', rc, row_to_json(stored), w;
 END IF;
 -- e. A newer run: the older run is refused (read again), the newer one taken.
 run2 := pg_temp.hourly_run('{2,5,7}');
 IF NOT pg_temp.hourly_refused('rayleigh', run1, '{2,5}') THEN
  RAISE EXCEPTION 'hourly contract: a receipt for a run that is no longer the newest was accepted';
 END IF;
 IF public.context_scorecard_record_receipt('rayleigh', run2, '{2,5,7}')->>'kind' <> 'red_rows' THEN
  RAISE EXCEPTION 'hourly contract: the receipt for the newest run was refused or mislabelled';
 END IF;
 -- f. All clear (amber rows are not red): nothing to pass on, the kind says so; red rows given anyway are refused.
 run3 := pg_temp.hourly_run('{}', '{3}');
 IF NOT pg_temp.hourly_refused('rayleigh', run3, '{3}')
    OR public.context_scorecard_record_receipt('rayleigh', run3, '{}')->>'kind' <> 'all_clear' THEN
  RAISE EXCEPTION 'hourly contract: an all-clear receipt was wrong';
 END IF;
 -- g. Failing: the newest run failed; the red rows passed on are the last good run's.
 run4 := pg_temp.hourly_run('{7}');
 DELETE FROM pg_temp.hourly_card;
 INSERT INTO pg_temp.hourly_card VALUES ('{"version": "x", "summary": {}, "rows": []}');
 run5 := (public.context_scorecard_record_run('manual')->>'run_id')::bigint;
 IF (SELECT status FROM public.context_scorecard_runs WHERE id = run5) <> 'failed' THEN
  RAISE EXCEPTION 'hourly contract: the failing fixture did not fail';
 END IF;
 IF NOT pg_temp.hourly_refused('rayleigh', run4, '{7}') OR NOT pg_temp.hourly_refused('rayleigh', run5, '{}') THEN
  RAISE EXCEPTION 'hourly contract: a failing receipt for the older run or without the last good red rows was accepted';
 END IF;
 rc := public.context_scorecard_record_receipt('rayleigh', run5, '{7}');
 IF rc->>'kind' <> 'failing' OR rc->'red_rows' <> '[7]' OR (rc->>'run_id')::bigint <> run5 THEN
  RAISE EXCEPTION 'hourly contract: a failing receipt was wrong: %', rc;
 END IF;
 IF (SELECT count(*) FROM public.context_scorecard_receipts) <> 4 THEN
  RAISE EXCEPTION 'hourly contract: expected four receipts, found %', (SELECT count(*) FROM public.context_scorecard_receipts);
 END IF;
END $receipt$;
ROLLBACK;
-- h. Late: the newest run is older than 75 minutes; the receipt says the reader passed that on.
BEGIN;
INSERT INTO public.context_scorecard_runs (run_trigger, as_of, started_at, finished_at, duration_ms, status, scorecard_version, summary, row_status, red_rows)
VALUES ('cron', now() - interval '2 hours', now() - interval '2 hours', now() - interval '2 hours', 1000, 'ok', 'v', '{}', pg_temp.hourly_row_status('{3}'), '{3}');
DO $$
DECLARE rc jsonb := public.context_scorecard_record_receipt('rayleigh', (SELECT max(id) FROM public.context_scorecard_runs), '{3}');
BEGIN
 IF rc->>'kind' <> 'late' OR rc->'red_rows' <> '[3]' THEN
  RAISE EXCEPTION 'hourly contract: a receipt of a late run was not kept as late: %', rc;
 END IF;
END $$;
ROLLBACK;

-- 6. Runs past the keep window are deleted by the recorder, their receipts with them; newer ones stay.
BEGIN;
INSERT INTO public.context_scorecard_runs (run_trigger, as_of, started_at, finished_at, duration_ms, status, error_code)
VALUES ('cron', now() - interval '181 days', now() - interval '181 days', now() - interval '181 days', 0, 'failed', '57014'),
       ('cron', now() - interval '179 days', now() - interval '179 days', now() - interval '179 days', 0, 'failed', '57014');
INSERT INTO public.context_scorecard_receipts (run_id, reader, received_at, kind, red_rows)
SELECT id, 'rayleigh', as_of + interval '5 minutes', 'failing', '{}' FROM public.context_scorecard_runs;
DO $$
DECLARE r jsonb := public.context_scorecard_record_run('manual');
BEGIN
 IF (r->>'pruned')::integer <> 1 OR EXISTS (SELECT 1 FROM public.context_scorecard_runs WHERE as_of < now() - interval '180 days')
    OR NOT EXISTS (SELECT 1 FROM public.context_scorecard_runs WHERE as_of = now() - interval '179 days')
    OR (SELECT count(*) FROM public.context_scorecard_receipts) <> 1
    OR NOT EXISTS (SELECT 1 FROM public.context_scorecard_receipts WHERE received_at = now() - interval '179 days' + interval '5 minutes') THEN
  RAISE EXCEPTION 'hourly contract: the keep window is wrong: %', r;
 END IF;
END $$;
ROLLBACK;

-- 7. The status read, graded at pinned instants on fixed runs and receipts
--    (12:45 Perth, 7 Oct 2026 = 04:45Z).
BEGIN;
SET LOCAL TimeZone = 'UTC';
-- Without pg_cron the job cannot be checked, which is red: never assumed scheduled.
INSERT INTO public.context_scorecard_runs (run_trigger, as_of, started_at, finished_at, duration_ms, status, scorecard_version, summary, row_status, red_rows)
VALUES ('cron', '2026-10-07 04:40Z', '2026-10-07 04:40Z', '2026-10-07 04:40:01Z', 1000, 'ok', 'v', '{}', pg_temp.hourly_row_status('{}'), '{}');
DO $$
DECLARE s jsonb := public.context_scorecard_run_status('2026-10-07 04:45Z');
BEGIN
 IF (s->'cron'->>'readable')::boolean OR s->'lane'->>'status' <> 'red' OR position('cannot be read here' IN s->'lane'->>'note') = 0 THEN
  RAISE EXCEPTION 'hourly contract: an unreadable pg_cron job did not read red: %', s->'lane';
 END IF;
END $$;
DELETE FROM public.context_scorecard_runs;
-- A pg_cron stand-in (pg_cron 1.6 columns) holding the policy's job.
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, schedule text NOT NULL, command text NOT NULL, active boolean NOT NULL DEFAULT true, jobname text);
INSERT INTO cron.job (jobname, schedule, command)
SELECT p->>'cron_job', p->>'schedule', p->>'command' FROM (SELECT public.context_scorecard_run_policy() AS p) x;
-- 24 hourly ok runs at minute 40, 6 Oct 05:40Z to 7 Oct 04:40Z; rows 2 and 5 red until 7 Oct 03:40Z, then 2 and 7.
INSERT INTO public.context_scorecard_runs (run_trigger, as_of, started_at, finished_at, duration_ms, status, scorecard_version, live_jobs,
  summary, row_status, red_rows, red_lanes)
SELECT 'cron', t, t, t + interval '1 second', 1100, 'ok', 'context-scorecard-v1', 3, '{}',
  pg_temp.hourly_row_status(CASE WHEN t < '2026-10-07 04:40Z' THEN '{2,5}'::integer[] ELSE '{2,7}'::integer[] END),
  CASE WHEN t < '2026-10-07 04:40Z' THEN '{2,5}'::integer[] ELSE '{2,7}'::integer[] END,
  CASE WHEN t < '2026-10-07 04:40Z' THEN '{2:a,5:b}'::text[] ELSE '{2:a,7:c}'::text[] END
FROM generate_series('2026-10-06 05:40Z'::timestamptz, '2026-10-07 04:40Z', interval '1 hour') t;
-- Rayleigh's receipt five minutes after each run, passing on that run's red rows.
CREATE TEMP TABLE hourly_receipts ON COMMIT DROP AS
SELECT id AS run_id, 'rayleigh'::text AS reader, as_of + interval '5 minutes' AS received_at, 'red_rows'::text AS kind, red_rows
FROM public.context_scorecard_runs;
INSERT INTO public.context_scorecard_receipts (run_id, reader, received_at, kind, red_rows)
SELECT run_id, reader, received_at, kind, red_rows FROM pg_temp.hourly_receipts;
DO $status$
DECLARE s jsonb;
BEGIN
 -- Green: on time, every hour covered, the job as the policy says, the red rows received by rayleigh.
 s := public.context_scorecard_run_status('2026-10-07 04:45Z');
 IF s->'lane'->>'status' <> 'green' OR (s->'lane'->>'number')::integer <> 0 OR (s->'lane'->>'row')::integer <> 10
    OR s->'lane'->>'lane' <> 'hourly_run' OR (s->'lane'->>'higher_is_better')::boolean
    OR (s->'window'->>'hours_checked')::integer <> 23 OR (s->'window'->>'runs')::integer <> 24 OR (s->'window'->>'receipts')::integer <> 24
    OR (s->>'last_run_at')::timestamptz <> '2026-10-07 04:40Z' OR (s->'last_run'->>'minutes_ago')::integer <> 5
    OR s->'red_rows' <> '[2, 7]' OR s->'red_lanes' <> '["2:a", "7:c"]'
    OR s->'changes'->'newly_red' <> '[7]' OR s->'changes'->'cleared' <> '[5]'
    OR NOT (s->'cron'->>'readable')::boolean OR NOT (s->'cron'->>'exists')::boolean OR NOT (s->'cron'->>'active')::boolean
    OR NOT (s->'cron'->>'command_matches')::boolean OR NOT (s->'cron'->>'schedule_matches')::boolean
    OR (s->>'consecutive_failures')::integer <> 0
    OR s->'lane'->>'value' IS DISTINCT FROM 'newest run 12:40 Perth on 7 Oct, ok in 1100 ms; 0 of 23 hours missed; 2 red rows passed on by rayleigh at 12:45 Perth'
    OR s->'lane'->>'note' IS DISTINCT FROM 'pg_cron context-scorecard-hourly at 40 * * * * UTC; rayleigh reads context_scorecard_run_status hourly and passes on only the red rows' THEN
  RAISE EXCEPTION 'hourly contract: a healthy hourly run did not read green: %', s - 'policy' - 'last_ok_run';
 END IF;
 IF s->'report'->>'kind' IS DISTINCT FROM 'red_rows'
    OR s->'report'->>'message' IS DISTINCT FROM 'Context system hourly check: 2 of 14 rows red at 12:40 Perth on 7 Oct (rows 2, 7).'
    OR (s->'report'->>'run_id')::bigint <> (SELECT id FROM public.context_scorecard_runs WHERE as_of = '2026-10-07 04:40Z')
    OR s->'report'->'red_rows' <> '[2, 7]' OR NOT (s->'report'->>'reported')::boolean OR s->'report'->'failing_since' <> 'null'::jsonb
    OR s->'report'->'receipt'->>'reader' <> 'rayleigh' OR (s->'report'->'receipt'->>'minutes_ago')::integer <> 0
    OR s->'report'->'receipt'->'red_rows' <> '[2, 7]' THEN
  RAISE EXCEPTION 'hourly contract: a healthy hourly run did not say what to pass on: %', s->'report';
 END IF;
 IF s->'lane'->>'value' ~ '[\u2014\u2013]' OR s->'lane'->>'note' ~ '[\u2014\u2013]' OR s->'report'->>'message' ~ '[\u2014\u2013]' THEN
  RAISE EXCEPTION 'hourly contract: lane or report words carry an em or en dash';
 END IF;
 -- Between a run and its receipt the previous receipt still counts (59 minutes).
 s := public.context_scorecard_run_status('2026-10-07 04:44Z');
 IF s->'lane'->>'status' <> 'green' OR (s->'report'->'receipt'->>'minutes_ago')::integer <> 59
    OR s->'lane'->>'value' NOT LIKE '%; 2 red rows passed on by rayleigh at 11:45 Perth' THEN
  RAISE EXCEPTION 'hourly contract: the previous receipt did not cover a run not yet read: %', s->'lane';
 END IF;
 -- The instant cuts the runs and the receipts: later ones are left out.
 s := public.context_scorecard_run_status('2026-10-07 00:45Z');
 IF (s->>'last_run_at')::timestamptz <> '2026-10-07 00:40Z' OR s->'lane'->>'status' <> 'green' OR s->'red_rows' <> '[2, 5]'
    OR (s->'report'->'receipt'->>'received_at')::timestamptz <> '2026-10-07 00:45Z' THEN
  RAISE EXCEPTION 'hourly contract: runs or receipts after p_as_of were read: % %', s->>'last_run_at', s->'report'->'receipt';
 END IF;
END $status$;
-- No reader received the red rows: red, whatever pg_cron does.
DELETE FROM public.context_scorecard_receipts;
DO $$
DECLARE s jsonb := public.context_scorecard_run_status('2026-10-07 04:45Z');
BEGIN
 IF s->'lane'->>'status' <> 'red' THEN
  RAISE EXCEPTION 'hourly contract: the lane read green with no reader receipt: %', s->'lane';
 END IF;
 IF s->'lane'->>'note' IS DISTINCT FROM 'red rows reported to no reader: no receipt from rayleigh yet'
    OR s->'lane'->>'value' NOT LIKE '%; red rows reported to no reader' OR (s->'report'->>'reported')::boolean
    OR s->'report'->'receipt' <> 'null'::jsonb OR s->'report'->>'kind' <> 'red_rows' THEN
  RAISE EXCEPTION 'hourly contract: no receipt did not read as reported to no reader: % %', s->'lane', s->'report';
 END IF;
END $$;
-- A receipt from a reader the policy does not name counts for nothing.
INSERT INTO public.context_scorecard_receipts (run_id, reader, received_at, kind, red_rows)
SELECT id, 'jarvis', '2026-10-07 04:45Z', 'red_rows', red_rows FROM public.context_scorecard_runs WHERE as_of = '2026-10-07 04:40Z';
DO $$ BEGIN
 IF public.context_scorecard_run_status('2026-10-07 04:45Z')->'lane'->>'note' IS DISTINCT FROM 'red rows reported to no reader: no receipt from rayleigh yet' THEN
  RAISE EXCEPTION 'hourly contract: a receipt from an unnamed reader counted';
 END IF;
END $$;
-- A receipt 76 minutes old is stale; 75 is not; one after p_as_of is not read.
INSERT INTO public.context_scorecard_receipts (run_id, reader, received_at, kind, red_rows)
SELECT id, 'rayleigh', '2026-10-07 03:29Z', 'red_rows', red_rows FROM public.context_scorecard_runs WHERE as_of = '2026-10-07 02:40Z';
DO $$ BEGIN
 IF public.context_scorecard_run_status('2026-10-07 04:45Z')->'lane'->>'status' <> 'red'
    OR public.context_scorecard_run_status('2026-10-07 04:45Z')->'lane'->>'note'
       IS DISTINCT FROM 'red rows reported to no reader: the newest receipt from rayleigh was 76 minutes ago' THEN
  RAISE EXCEPTION 'hourly contract: a stale receipt counted: %', public.context_scorecard_run_status('2026-10-07 04:45Z')->'lane';
 END IF;
END $$;
UPDATE public.context_scorecard_receipts SET received_at = '2026-10-07 03:30Z' WHERE reader = 'rayleigh';
DO $$ BEGIN
 IF public.context_scorecard_run_status('2026-10-07 04:45Z')->'lane'->>'status' <> 'green' THEN
  RAISE EXCEPTION 'hourly contract: a receipt 75 minutes old did not count: %', public.context_scorecard_run_status('2026-10-07 04:45Z')->'lane';
 END IF;
END $$;
DELETE FROM public.context_scorecard_receipts;
INSERT INTO public.context_scorecard_receipts (run_id, reader, received_at, kind, red_rows)
SELECT id, 'rayleigh', '2026-10-07 04:50Z', 'red_rows', red_rows FROM public.context_scorecard_runs WHERE as_of = '2026-10-07 04:40Z';
DO $$ BEGIN
 IF public.context_scorecard_run_status('2026-10-07 04:45Z')->'lane'->>'note' IS DISTINCT FROM 'red rows reported to no reader: no receipt from rayleigh yet'
    OR public.context_scorecard_run_status('2026-10-07 04:50Z')->'lane'->>'status' <> 'green' THEN
  RAISE EXCEPTION 'hourly contract: a receipt after p_as_of was read, or one at p_as_of was not';
 END IF;
END $$;
DELETE FROM public.context_scorecard_receipts;
INSERT INTO public.context_scorecard_receipts (run_id, reader, received_at, kind, red_rows)
SELECT run_id, reader, received_at, kind, red_rows FROM pg_temp.hourly_receipts;
-- Late: no run for 80 minutes. The reader is the dead-man switch: it is told
-- the job may have stopped, with the last red rows; 74 minutes is within the grace.
DO $$
DECLARE s jsonb;
BEGIN
 s := public.context_scorecard_run_status('2026-10-07 06:00Z');
 IF s->'lane'->>'status' <> 'red' OR position('late: the newest run was 80 minutes ago' IN s->'lane'->>'note') = 0
    OR position('reported to no reader' IN s->'lane'->>'note') > 0 OR s->'report'->>'kind' IS DISTINCT FROM 'late'
    OR s->'report'->>'message' IS DISTINCT FROM 'Context system hourly check: no run since 12:40 Perth on 7 Oct (80 minutes ago), so the hourly job may have stopped. The last good run, 12:40 Perth on 7 Oct, had 2 of 14 rows red (rows 2, 7).' THEN
  RAISE EXCEPTION 'hourly contract: a late run was not reported to the reader: % %', s->'lane', s->'report';
 END IF;
 s := public.context_scorecard_run_status('2026-10-07 06:01Z');
 IF position('the newest receipt from rayleigh was 76 minutes ago' IN s->'lane'->>'note') = 0 THEN
  RAISE EXCEPTION 'hourly contract: a reader that stopped reading was not named: %', s->'lane';
 END IF;
 s := public.context_scorecard_run_status('2026-10-07 05:54Z');
 IF position('late' IN s->'lane'->>'note') > 0 OR s->'report'->>'kind' <> 'red_rows' THEN
  RAISE EXCEPTION 'hourly contract: a run inside the grace read late: %', s->'lane';
 END IF;
END $$;
-- All clear: nothing to pass on ("reports only red rows"), and the receipt still shows the reader read it.
SAVEPOINT hourly_all_clear;
UPDATE public.context_scorecard_runs SET red_rows = '{}', red_lanes = '{}', row_status = pg_temp.hourly_row_status('{}')
WHERE as_of = '2026-10-07 04:40Z';
UPDATE public.context_scorecard_receipts SET kind = 'all_clear', red_rows = '{}' WHERE received_at = '2026-10-07 04:45Z';
DO $$
DECLARE s jsonb := public.context_scorecard_run_status('2026-10-07 04:45Z');
BEGIN
 IF s->'lane'->>'status' <> 'green' OR s->'report'->>'kind' <> 'all_clear' OR s->'report'->'message' <> 'null'::jsonb
    OR s->'lane'->>'value' NOT LIKE '%; read by rayleigh at 12:45 Perth, no red rows' THEN
  RAISE EXCEPTION 'hourly contract: an all-clear hour was not quiet and green: % %', s->'lane', s->'report';
 END IF;
END $$;
ROLLBACK TO SAVEPOINT hourly_all_clear;
-- One missed hour is amber, two are red, and they are named.
DELETE FROM public.context_scorecard_runs WHERE as_of = '2026-10-06 20:40Z';
DO $$
DECLARE s jsonb := public.context_scorecard_run_status('2026-10-07 04:45Z');
BEGIN
 IF s->'lane'->>'status' <> 'amber' OR (s->'lane'->>'number')::integer <> 1 OR (s->'window'->'missed_hours'->>0)::timestamptz <> '2026-10-06 20:00Z' THEN
  RAISE EXCEPTION 'hourly contract: one missed hour did not read amber: %', s->'window';
 END IF;
END $$;
DELETE FROM public.context_scorecard_runs WHERE as_of = '2026-10-06 08:40Z';
DO $$
DECLARE s jsonb := public.context_scorecard_run_status('2026-10-07 04:45Z');
BEGIN
 IF s->'lane'->>'status' <> 'red' OR (s->'lane'->>'number')::integer <> 2 THEN
  RAISE EXCEPTION 'hourly contract: two missed hours did not read red: %', s->'window';
 END IF;
END $$;
-- A failed newest run is red, the failures are counted in a row, and the
-- reader is told since when, with the newest code, refreshed as they go on.
INSERT INTO public.context_scorecard_runs (run_trigger, as_of, started_at, finished_at, duration_ms, status, error_code)
VALUES ('cron', '2026-10-07 04:41Z', '2026-10-07 04:41Z', '2026-10-07 04:42Z', 60000, 'failed', '57014'),
       ('cron', '2026-10-07 04:42Z', '2026-10-07 04:42Z', '2026-10-07 04:43Z', 60000, 'failed', '55P03');
DO $$
DECLARE s jsonb := public.context_scorecard_run_status('2026-10-07 04:45Z');
BEGIN
 IF s->'lane'->>'status' <> 'red' OR (s->>'consecutive_failures')::integer <> 2
    OR position('the newest run failed (55P03), 2 in a row' IN s->'lane'->>'note') = 0
    OR s->'red_rows' <> '[2, 7]' OR s->'last_run'->>'error_code' <> '55P03' THEN
  RAISE EXCEPTION 'hourly contract: a failed newest run did not read red: %', s->'lane';
 END IF;
 IF s->'report'->>'kind' IS DISTINCT FROM 'failing' OR (s->'report'->>'failing_since')::timestamptz <> '2026-10-07 04:41Z'
    OR (s->'report'->>'run_id')::bigint <> (SELECT id FROM public.context_scorecard_runs WHERE as_of = '2026-10-07 04:42Z')
    OR s->'report'->>'message' IS DISTINCT FROM 'Context system hourly check failing since 12:41 Perth on 7 Oct (55P03): 2 failed runs in a row. The last good run, 12:40 Perth on 7 Oct, had 2 of 14 rows red (rows 2, 7).' THEN
  RAISE EXCEPTION 'hourly contract: failing runs were not reported to the reader: %', s->'report';
 END IF;
END $$;
INSERT INTO public.context_scorecard_runs (run_trigger, as_of, started_at, finished_at, duration_ms, status, error_code)
VALUES ('cron', '2026-10-07 04:43Z', '2026-10-07 04:43Z', '2026-10-07 04:44Z', 60000, 'failed', '57014');
DO $$
DECLARE s jsonb;
BEGIN
 s := public.context_scorecard_run_status('2026-10-07 04:45Z');
 IF s->'report'->>'message' IS DISTINCT FROM 'Context system hourly check failing since 12:41 Perth on 7 Oct (57014): 3 failed runs in a row. The last good run, 12:40 Perth on 7 Oct, had 2 of 14 rows red (rows 2, 7).' THEN
  RAISE EXCEPTION 'hourly contract: the failing report was not refreshed: %', s->'report';
 END IF;
 -- Failing and then silent: still reported, as late, with the failure named.
 s := public.context_scorecard_run_status('2026-10-07 06:00Z');
 IF s->'report'->>'kind' IS DISTINCT FROM 'late' OR (s->'report'->>'failing_since')::timestamptz <> '2026-10-07 04:41Z'
    OR s->'report'->>'message' IS DISTINCT FROM 'Context system hourly check: no run since 12:43 Perth on 7 Oct (77 minutes ago), so the hourly job may have stopped. That run failed (57014). The last good run, 12:40 Perth on 7 Oct, had 2 of 14 rows red (rows 2, 7).' THEN
  RAISE EXCEPTION 'hourly contract: a failing job that went silent was not reported: %', s->'report';
 END IF;
END $$;
-- The next good run ends the streak.
INSERT INTO public.context_scorecard_runs (run_trigger, as_of, started_at, finished_at, duration_ms, status, scorecard_version, summary, row_status, red_rows)
VALUES ('manual', '2026-10-07 04:44Z', '2026-10-07 04:44Z', '2026-10-07 04:44:01Z', 1000, 'ok', 'v', '{}', pg_temp.hourly_row_status('{2,7}'), '{2,7}');
DO $$
DECLARE s jsonb := public.context_scorecard_run_status('2026-10-07 04:45Z');
BEGIN
 IF s->'report'->>'kind' <> 'red_rows' OR s->'report'->'failing_since' <> 'null'::jsonb OR (s->>'consecutive_failures')::integer <> 0
    OR s->'report'->>'message' IS DISTINCT FROM 'Context system hourly check: 2 of 14 rows red at 12:44 Perth on 7 Oct (rows 2, 7).' THEN
  RAISE EXCEPTION 'hourly contract: a good run did not end the failing streak: %', s->'report';
 END IF;
END $$;
DELETE FROM public.context_scorecard_runs WHERE as_of > '2026-10-07 04:40Z';
-- The job paused, changed or gone is red.
UPDATE cron.job SET active = false;
DO $$ BEGIN
 IF position('is paused' IN public.context_scorecard_run_status('2026-10-07 04:45Z')->'lane'->>'note') = 0 THEN
  RAISE EXCEPTION 'hourly contract: a paused job did not read red';
 END IF;
END $$;
UPDATE cron.job SET active = true, command = 'SELECT public.context_scorecard_record_run(''cron'')';
DO $$ BEGIN
 IF position('differs from the policy' IN public.context_scorecard_run_status('2026-10-07 04:45Z')->'lane'->>'note') = 0 THEN
  RAISE EXCEPTION 'hourly contract: a job with another command did not read red';
 END IF;
END $$;
DELETE FROM cron.job;
DO $$ BEGIN
 IF position('no pg_cron job named context-scorecard-hourly' IN public.context_scorecard_run_status('2026-10-07 04:45Z')->'lane'->>'note') = 0 THEN
  RAISE EXCEPTION 'hourly contract: a missing job did not read red';
 END IF;
END $$;
INSERT INTO cron.job (jobname, schedule, command)
SELECT p->>'cron_job', p->>'schedule', p->>'command' FROM (SELECT public.context_scorecard_run_policy() AS p) x, generate_series(1, 2);
DO $$ BEGIN
 IF position('2 pg_cron jobs named context-scorecard-hourly' IN public.context_scorecard_run_status('2026-10-07 04:45Z')->'lane'->>'note') = 0 THEN
  RAISE EXCEPTION 'hourly contract: two jobs of one name did not read red';
 END IF;
END $$;
DELETE FROM cron.job WHERE jobid = (SELECT max(jobid) FROM cron.job);
-- A slow run is amber.
UPDATE public.context_scorecard_runs SET duration_ms = 45000 WHERE as_of = '2026-10-07 04:40Z';
DO $$
DECLARE s jsonb := public.context_scorecard_run_status('2026-10-07 04:45Z');
BEGIN
 IF position('slow: the newest run took 45000 ms' IN s->'lane'->>'note') = 0 THEN
  RAISE EXCEPTION 'hourly contract: a slow run was not named: %', s->'lane';
 END IF;
END $$;
UPDATE public.context_scorecard_runs SET duration_ms = 1100 WHERE as_of = '2026-10-07 04:40Z';
-- No run at all: red, and the reader is told so; nothing about receipts until there is a run.
DELETE FROM public.context_scorecard_runs;
DO $$
DECLARE s jsonb := public.context_scorecard_run_status('2026-10-07 04:45Z');
BEGIN
 IF s->'lane'->>'status' <> 'red' OR s->'lane'->'number' <> 'null'::jsonb OR s->'last_run' <> 'null'::jsonb
    OR s->'lane'->>'value' <> 'no hourly run recorded yet' OR s->'lane'->>'note' IS DISTINCT FROM 'no run recorded yet'
    OR s->'report'->>'kind' <> 'no_run' OR s->'report'->>'message' IS DISTINCT FROM 'Context system hourly check: no run recorded yet.'
    OR EXISTS (SELECT 1 FROM public.context_scorecard_receipts) THEN
  RAISE EXCEPTION 'hourly contract: no run did not read red: % %', s->'lane', s->'report';
 END IF;
END $$;
ROLLBACK;

-- 8. The schedule, on a pg_cron stand-in: created from the policy, once, on re-apply.
BEGIN;
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, schedule text NOT NULL, command text NOT NULL, active boolean NOT NULL DEFAULT true, jobname text);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint LANGUAGE sql AS $$
 INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command) RETURNING jobid
$$;
\ir ../../../migrations/20261007040000_context_scorecard_hourly.sql
\ir ../../../migrations/20261007040000_context_scorecard_hourly.sql
DO $$
DECLARE pol jsonb := public.context_scorecard_run_policy();
BEGIN
 IF (SELECT count(*) FROM cron.job WHERE jobname = 'context-scorecard-hourly') <> 1 THEN
  RAISE EXCEPTION 'hourly contract: re-apply scheduled the job % times', (SELECT count(*) FROM cron.job);
 END IF;
 IF (SELECT schedule FROM cron.job WHERE jobname = 'context-scorecard-hourly') <> '40 * * * *'
    OR (SELECT command FROM cron.job WHERE jobname = 'context-scorecard-hourly') <> pol->>'command'
    OR NOT (SELECT active FROM cron.job WHERE jobname = 'context-scorecard-hourly') THEN
  RAISE EXCEPTION 'hourly contract: job %', (SELECT row_to_json(j) FROM cron.job j);
 END IF;
 IF NOT (public.context_scorecard_run_status()->'cron'->>'command_matches')::boolean THEN
  RAISE EXCEPTION 'hourly contract: the status does not recognise the job the migration scheduled';
 END IF;
END $$;
ROLLBACK;

-- 9. The rollback, inside a rolled-back transaction: unschedules, drops the
--    four functions and two tables, leaves the rest. The rollback refuses while
--    the scorecard reads the run status (the scorecard v2, 20261007120000, does),
--    so a live body that reads it is first replaced by W11's, word for word
--    (20261006032000's w11_scorecard.sql), inside this transaction.
SELECT position('context_scorecard_run_status' IN prosrc) > 0 AS hourly_card_reads_status
FROM pg_proc WHERE oid = 'public.context_scorecard(timestamptz)'::regprocedure \gset
BEGIN;
\if :hourly_card_reads_status
\ir ../20261006032000_context_scorecard/w11_scorecard.sql
\endif
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, schedule text NOT NULL, command text NOT NULL, active boolean NOT NULL DEFAULT true, jobname text);
CREATE FUNCTION cron.unschedule(job_name text) RETURNS boolean LANGUAGE sql AS $$
 WITH d AS (DELETE FROM cron.job WHERE jobname = job_name RETURNING 1) SELECT count(*) > 0 FROM d
$$;
INSERT INTO cron.job (jobname, schedule, command)
SELECT p->>'cron_job', p->>'schedule', p->>'command' FROM (SELECT public.context_scorecard_run_policy() AS p) x;
INSERT INTO cron.job (jobname, schedule, command) VALUES ('another-job', '* * * * *', 'SELECT 1');
\ir ../../../rollbacks/20261007040000_context_scorecard_hourly_down.sql
DO $$
BEGIN
 IF to_regprocedure('public.context_scorecard_run_status(timestamptz)') IS NOT NULL OR to_regprocedure('public.context_scorecard_record_run(text)') IS NOT NULL
    OR to_regprocedure('public.context_scorecard_record_receipt(text,bigint,integer[])') IS NOT NULL
    OR to_regprocedure('public.context_scorecard_run_policy()') IS NOT NULL OR to_regclass('public.context_scorecard_runs') IS NOT NULL
    OR to_regclass('public.context_scorecard_receipts') IS NOT NULL THEN
  RAISE EXCEPTION 'hourly contract: the rollback left an object behind';
 END IF;
 IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'context-scorecard-hourly') OR NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'another-job') THEN
  RAISE EXCEPTION 'hourly contract: the rollback unscheduled the wrong jobs';
 END IF;
 IF to_regprocedure('public.context_scorecard(timestamptz)') IS NULL THEN
  RAISE EXCEPTION 'hourly contract: the rollback touched the scorecard';
 END IF;
END $$;
ROLLBACK;
-- It refuses while the scorecard reads the run status, and leaves everything in place.
BEGIN;
CREATE OR REPLACE FUNCTION public.context_scorecard(p_as_of timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE sql STABLE AS $$ SELECT public.context_scorecard_run_status($1)->'lane' $$;
\echo 'hourly contract: the next ERROR is the expected rollback refusal'
\set ON_ERROR_STOP 0
\ir ../../../rollbacks/20261007040000_context_scorecard_hourly_down.sql
\set ON_ERROR_STOP 1
ROLLBACK;
SELECT position('context_scorecard_hourly_rollback_refused' IN :'LAST_ERROR_MESSAGE') > 0 AS hourly_down_refused \gset
\if :hourly_down_refused
\else
DO $$ BEGIN RAISE EXCEPTION 'hourly contract: the rollback did not refuse while the scorecard reads the run status'; END $$;
\endif
DO $$ BEGIN
 IF to_regprocedure('public.context_scorecard_run_status(timestamptz)') IS NULL OR to_regclass('public.context_scorecard_runs') IS NULL
    OR to_regclass('public.context_scorecard_receipts') IS NULL THEN
  RAISE EXCEPTION 'hourly contract: the refused rollback dropped something';
 END IF;
END $$;
