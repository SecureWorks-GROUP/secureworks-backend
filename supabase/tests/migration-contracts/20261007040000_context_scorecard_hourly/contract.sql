-- Contract for 20261007040000_context_scorecard_hourly: the hourly scorecard
-- run. The recorder runs the scorecard and stores every run, a failed,
-- timed-out or unreadable one as a failed run with its code; red rows are
-- reported as one open ai_alerts row that is refreshed, held after a person's
-- dismissal, raised anew when the rows change or the row was closed elsewhere,
-- and closed when no row is red; the status read grades the hourly run (late,
-- missed hours, failed, the pg_cron job, the report) as a row 10 lane; the job
-- is scheduled from the policy and re-applies once; the rollback unschedules,
-- closes and drops, and refuses while the scorecard reads the status. Every
-- fixture is synthetic and rolled back; a pg_cron stand-in lives only inside
-- its transaction. The status read is graded at pinned instants (p_as_of); the
-- recorder uses now() of its transaction and only relative facts are asserted.

-- 0. No pg_cron in the registered stack, so the migration scheduled nothing,
--    and no stand-in outlived an earlier contract.
DO $$
BEGIN
 IF to_regclass('cron.job') IS NOT NULL THEN
  RAISE EXCEPTION 'hourly contract: a cron.job stand-in outlived its transaction';
 END IF;
 IF EXISTS (SELECT 1 FROM public.context_scorecard_runs) OR EXISTS (SELECT 1 FROM public.ai_alerts WHERE alert_type = 'context_scorecard_red_rows') THEN
  RAISE EXCEPTION 'hourly contract: rows left behind before the contract';
 END IF;
END $$;

-- 1. Shape and access.
DO $shape$
DECLARE f text; p record; cols text;
BEGIN
 FOR p IN SELECT pr.oid::regprocedure::text AS sig, pr.prosecdef, pr.provolatile, pr.proconfig
          FROM pg_proc pr WHERE pr.oid IN ('public.context_scorecard_record_run(text)'::regprocedure,
                                           'public.context_scorecard_run_status(timestamptz)'::regprocedure) LOOP
  IF NOT p.prosecdef OR NOT ('search_path=public, pg_temp' = ANY (p.proconfig)) THEN
   RAISE EXCEPTION 'hourly contract: % must be SECURITY DEFINER with search_path public, pg_temp', p.sig;
  END IF;
 END LOOP;
 IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.context_scorecard_record_run(text)'::regprocedure) <> 'v'
    OR (SELECT provolatile FROM pg_proc WHERE oid = 'public.context_scorecard_run_status(timestamptz)'::regprocedure) <> 's'
    OR (SELECT provolatile FROM pg_proc WHERE oid = 'public.context_scorecard_run_policy()'::regprocedure) <> 'i' THEN
  RAISE EXCEPTION 'hourly contract: volatility wrong (recorder volatile, status stable, policy immutable)';
 END IF;
 FOREACH f IN ARRAY ARRAY['public.context_scorecard_run_policy()', 'public.context_scorecard_record_run(text)',
   'public.context_scorecard_run_status(timestamptz)'] LOOP
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
     OR has_function_privilege('public', f, 'EXECUTE') OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
   RAISE EXCEPTION 'hourly contract: % access wrong', f;
  END IF;
  IF obj_description(to_regprocedure(f), 'pg_proc') NOT LIKE 'Context scorecard hourly (20261007040000)%' THEN
   RAISE EXCEPTION 'hourly contract: % comment does not name the migration', f;
  END IF;
 END LOOP;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.context_scorecard_runs'::regclass)
    OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'context_scorecard_runs')
    OR has_table_privilege('anon', 'public.context_scorecard_runs', 'SELECT')
    OR has_table_privilege('authenticated', 'public.context_scorecard_runs', 'SELECT')
    OR NOT has_table_privilege('service_role', 'public.context_scorecard_runs', 'SELECT')
    OR has_table_privilege('service_role', 'public.context_scorecard_runs', 'INSERT')
    OR has_table_privilege('service_role', 'public.context_scorecard_runs', 'UPDATE')
    OR has_table_privilege('service_role', 'public.context_scorecard_runs', 'DELETE') THEN
  RAISE EXCEPTION 'hourly contract: run log access wrong (RLS on, no policy, service_role read only)';
 END IF;
 IF obj_description('public.context_scorecard_runs'::regclass, 'pg_class') NOT LIKE 'Context scorecard hourly (20261007040000)%' THEN
  RAISE EXCEPTION 'hourly contract: run log comment does not name the migration';
 END IF;
 -- red_lanes sorts in C order wherever it is compared or ordered.
 IF (SELECT c.collname FROM pg_attribute a JOIN pg_collation c ON c.oid = a.attcollation
     WHERE a.attrelid = 'public.context_scorecard_runs'::regclass AND a.attname = 'red_lanes') IS DISTINCT FROM 'C' THEN
  RAISE EXCEPTION 'hourly contract: red_lanes must be COLLATE "C"';
 END IF;
END $shape$;

-- 2. The policy: every number of the hourly run, and the job's command built from them.
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
    OR pol->'report'->>'surface' IS DISTINCT FROM 'public.ai_alerts' OR pol->'report'->>'alert_type' IS DISTINCT FROM 'context_scorecard_red_rows'
    OR pol->'report'->>'severity' IS DISTINCT FROM 'red' OR (pol->'report'->>'dismissed_quiet_hours')::integer <> 24
    OR pol->'report'->>'org_id' IS DISTINCT FROM '00000000-0000-0000-0000-000000000001' THEN
  RAISE EXCEPTION 'hourly contract: policy wrong: %', pol;
 END IF;
 -- The run's own limit stays under the server's 120 s and far above the measured 1.24 s.
 IF extract(epoch FROM (pol->>'statement_timeout')::interval) NOT BETWEEN 10 AND 110
    OR (pol->>'slow_after_ms')::numeric >= extract(epoch FROM (pol->>'statement_timeout')::interval) * 1000 THEN
  RAISE EXCEPTION 'hourly contract: statement timeout or slow limit out of range: %', pol;
 END IF;
END $policy$;

-- 3. A real run: the recorder runs the registered scorecard and stores what it said.
BEGIN;
DO $real$
DECLARE r jsonb; run public.context_scorecard_runs; card jsonb; a public.ai_alerts;
BEGIN
 -- The card as the recorder will see it (same instant, nothing written yet).
 card := public.context_scorecard(now());
 r := public.context_scorecard_record_run('manual');
 SELECT * INTO run FROM public.context_scorecard_runs WHERE id = (r->>'run_id')::bigint;
 IF run.id IS NULL OR run.status <> 'ok' OR run.error_code IS NOT NULL OR run.run_trigger <> 'manual' OR run.as_of <> now()
    OR run.finished_at < run.started_at OR r->>'status' <> 'ok' OR (r->>'duration_ms')::integer <> run.duration_ms THEN
  RAISE EXCEPTION 'hourly contract: a real run was not stored as ok: % %', r, row_to_json(run);
 END IF;
 IF run.scorecard_version IS DISTINCT FROM card->>'version' OR run.summary IS DISTINCT FROM card->'summary'
    OR run.live_jobs IS DISTINCT FROM (card->>'live_jobs')::integer OR run.alarms IS DISTINCT FROM card->'alarms' THEN
  RAISE EXCEPTION 'hourly contract: the run does not hold the scorecard''s version, summary, live jobs and alarms';
 END IF;
 IF jsonb_array_length(run.row_status) <> jsonb_array_length(card->'rows')
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(card->'rows') c
               WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(run.row_status) s
                                 WHERE (s->>'row')::integer = (c->>'row')::integer AND s->>'status' = c->>'status' AND s->>'stage' = c->>'stage'))
    OR run.red_rows <> ARRAY(SELECT (c->>'row')::integer FROM jsonb_array_elements(card->'rows') c WHERE c->>'status' = 'red' ORDER BY 1)
    OR run.red_lanes <> ARRAY(SELECT (c.v->>'row') || ':' || (l.v->>'lane')
                              FROM jsonb_array_elements(card->'rows') WITH ORDINALITY AS c(v, o)
                              CROSS JOIN LATERAL jsonb_array_elements(c.v->'lanes') WITH ORDINALITY AS l(v, o)
                              WHERE l.v->>'status' = 'red' ORDER BY (c.v->>'row')::integer, c.o, l.o)
    OR jsonb_array_length(run.red_lane_values) <> cardinality(run.red_lanes) THEN
  RAISE EXCEPTION 'hourly contract: row statuses, red rows or red lanes differ from the scorecard: % %', run.red_rows, run.red_lanes;
 END IF;
 IF r->'report' <> run.report THEN
  RAISE EXCEPTION 'hourly contract: the run returned a report it did not store: % %', r->'report', run.report;
 END IF;
 -- An empty stack's scorecard has red rows (the graded samples are not stored), so this run reports;
 -- if a later scorecard ever reads all clear here, the run must say there was nothing to report.
 IF cardinality(run.red_rows) = 0 THEN
  IF run.report->>'action' IS DISTINCT FROM 'none' OR EXISTS (SELECT 1 FROM public.ai_alerts WHERE alert_type = 'context_scorecard_red_rows') THEN
   RAISE EXCEPTION 'hourly contract: an all-clear run reported: %', run.report;
  END IF;
  RETURN;
 END IF;
 IF run.report->>'action' IS DISTINCT FROM 'raised' THEN
  RAISE EXCEPTION 'hourly contract: a real run with red rows did not report them: %', run.report;
 END IF;
 SELECT * INTO a FROM public.ai_alerts WHERE id = (run.report->>'alert_id')::uuid;
 IF a.id IS NULL OR a.alert_type <> 'context_scorecard_red_rows' OR a.severity <> 'red' OR a.resolved_at IS NOT NULL
    OR a.dismissed_at IS NOT NULL OR a.org_id <> '00000000-0000-0000-0000-000000000001' OR a.job_id IS NOT NULL
    OR a.detail_json->'red_rows' <> to_jsonb(run.red_rows) OR (a.detail_json->>'run_id')::bigint <> run.id
    OR a.message NOT LIKE format('Context system hourly check: %s of %s rows red at %% Perth on %% (rows %s).',
         cardinality(run.red_rows), jsonb_array_length(run.row_status), array_to_string(run.red_rows, ', '))
    OR position('nothing was sent to anyone' IN lower(a.recommended_action)) = 0 THEN
  RAISE EXCEPTION 'hourly contract: the red-row alert is wrong: %', row_to_json(a);
 END IF;
 IF a.message ~ '[\u2014\u2013]' OR a.recommended_action ~ '[\u2014\u2013]' THEN
  RAISE EXCEPTION 'hourly contract: staff-facing words carry an em or en dash';
 END IF;
END $real$;
ROLLBACK;

-- 4. A scorecard that fails, times out or answers in an unreadable shape is a
--    failed run with its code: never a lost hour, never a report.
BEGIN;
CREATE OR REPLACE FUNCTION public.context_scorecard(p_as_of timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$ BEGIN RAISE EXCEPTION 'hourly stub: scorecard broken' USING ERRCODE = 'XX000'; END $$;
DO $fail$
DECLARE r jsonb; run public.context_scorecard_runs;
BEGIN
 r := public.context_scorecard_record_run('cron');
 SELECT * INTO run FROM public.context_scorecard_runs WHERE id = (r->>'run_id')::bigint;
 IF run.id IS NULL THEN RAISE EXCEPTION 'hourly contract: a failed scorecard left no run'; END IF;
 IF run.status <> 'failed' OR run.error_code <> 'XX000' OR run.run_trigger <> 'cron' OR run.summary IS NOT NULL OR run.row_status IS NOT NULL
    OR cardinality(run.red_rows) <> 0 OR run.report->>'action' <> 'not_run' OR r->>'status' <> 'failed' OR r->>'error_code' <> 'XX000' THEN
  RAISE EXCEPTION 'hourly contract: a failed scorecard was stored wrong: %', row_to_json(run);
 END IF;
 IF EXISTS (SELECT 1 FROM public.ai_alerts WHERE alert_type = 'context_scorecard_red_rows') THEN
  RAISE EXCEPTION 'hourly contract: a failed run reported';
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
DO $$ BEGIN
 IF public.context_scorecard_record_run('manual')->>'error_code' IS DISTINCT FROM 'card_shape' THEN
  RAISE EXCEPTION 'hourly contract: a card with no version was not card_shape';
 END IF;
 IF (SELECT count(*) FROM public.context_scorecard_runs WHERE status = 'failed') <> 4 THEN
  RAISE EXCEPTION 'hourly contract: expected four failed runs';
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
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.context_scorecard_runs WHERE status = 'failed' AND error_code = '57014' AND run_trigger = 'cron'
                AND duration_ms BETWEEN 200 AND 2900) THEN
  RAISE EXCEPTION 'hourly contract: the timed-out run row is missing or its duration is wrong';
 END IF;
END $$;
-- The trigger is cron or manual, nothing else.
DO $$ BEGIN
 PERFORM public.context_scorecard_record_run(NULL);
 RAISE EXCEPTION 'hourly contract: a null trigger was accepted';
EXCEPTION WHEN invalid_parameter_value THEN NULL;
END $$;
DO $$ BEGIN
 PERFORM public.context_scorecard_record_run('hourly');
 RAISE EXCEPTION 'hourly contract: an unknown trigger was accepted';
EXCEPTION WHEN invalid_parameter_value THEN NULL;
END $$;
ROLLBACK;

-- 4b. The job's timeout firing late (after the scorecard answered) still
--     leaves the run stored: cut in the report step, the report is failed with
--     the code; cut in the last write, the report is written once more and the
--     keep window waits for the next run.
BEGIN;
CREATE OR REPLACE FUNCTION public.context_scorecard(p_as_of timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE sql STABLE AS $$
 SELECT '{"version": "x", "summary": {}, "rows": [{"row": 4, "stage": "Four", "status": "red",
          "lanes": [{"lane": "slow_lane", "status": "red", "number": 1, "unit": "u", "value": "1 u"}]}]}'::jsonb
$$;
CREATE FUNCTION public.hourly_contract_slow() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$;
CREATE TRIGGER hourly_contract_slow BEFORE INSERT ON public.ai_alerts FOR EACH ROW EXECUTE FUNCTION public.hourly_contract_slow();
SET LOCAL statement_timeout = '300ms';
WITH x AS MATERIALIZED (SELECT public.context_scorecard_record_run('manual') AS r)
SELECT x.r->>'status' = 'ok' AND x.r->'report'->>'action' = 'failed' AND x.r->'report'->>'error_code' = '57014' AS hourly_late_report_ok FROM x \gset
SET LOCAL statement_timeout = 0;
\if :hourly_late_report_ok
\else
DO $$ BEGIN RAISE EXCEPTION 'hourly contract: a timeout in the report step lost the run or its code'; END $$;
\endif
DO $$ BEGIN
 IF (SELECT count(*) FROM public.context_scorecard_runs WHERE status = 'ok' AND report->>'action' = 'failed' AND report->>'error_code' = '57014') <> 1
    OR EXISTS (SELECT 1 FROM public.ai_alerts WHERE alert_type = 'context_scorecard_red_rows') THEN
  RAISE EXCEPTION 'hourly contract: the run cut in its report step is not stored as ok with a failed report';
 END IF;
END $$;
DROP TRIGGER hourly_contract_slow ON public.ai_alerts;
CREATE TRIGGER hourly_contract_slow BEFORE UPDATE ON public.context_scorecard_runs FOR EACH ROW EXECUTE FUNCTION public.hourly_contract_slow();
SET LOCAL statement_timeout = '300ms';
WITH x AS MATERIALIZED (SELECT public.context_scorecard_record_run('manual') AS r)
SELECT x.r->>'status' = 'ok' AND x.r->'report'->>'action' = 'raised' AND x.r->'report'->>'prune_skipped_code' = '57014'
       AND NOT x.r->'report' ? 'stored' AS hourly_late_store_ok FROM x \gset
SET LOCAL statement_timeout = 0;
\if :hourly_late_store_ok
\else
DO $$ BEGIN RAISE EXCEPTION 'hourly contract: a timeout in the last write lost the run or its report'; END $$;
\endif
DO $$
DECLARE run public.context_scorecard_runs;
BEGIN
 SELECT * INTO run FROM public.context_scorecard_runs ORDER BY id DESC LIMIT 1;
 IF run.status <> 'ok' OR run.report->>'action' <> 'raised' OR run.report->>'prune_skipped_code' <> '57014'
    OR NOT EXISTS (SELECT 1 FROM public.ai_alerts WHERE id = (run.report->>'alert_id')::uuid)
    OR NOT (public.context_scorecard_run_status()->'report'->>'reported')::boolean THEN
  RAISE EXCEPTION 'hourly contract: the run cut in its last write did not keep its report: %', run.report;
 END IF;
END $$;
ROLLBACK;

-- 5. The report, run by run, on fixed cards.
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
CREATE FUNCTION pg_temp.hourly_run(p_red integer[], p_amber integer[] DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM pg_temp.hourly_card;
 INSERT INTO pg_temp.hourly_card VALUES (pg_temp.hourly_card_for(p_red, p_amber));
 RETURN public.context_scorecard_record_run('manual')->'report';
END $$;
DO $report$
DECLARE r jsonb; a1 uuid; a2 uuid; a3 uuid; a4 uuid; a5 uuid; other uuid; run public.context_scorecard_runs; al public.ai_alerts;
BEGIN
 -- a. Rows 2 and 5 red: one alert raised, naming them; the run keeps why each is red.
 r := pg_temp.hourly_run('{2,5}');
 a1 := (r->>'alert_id')::uuid;
 SELECT * INTO run FROM public.context_scorecard_runs ORDER BY id DESC LIMIT 1;
 SELECT * INTO al FROM public.ai_alerts WHERE id = a1;
 IF r->>'action' <> 'raised' OR r->>'previous_state' <> 'none' OR al.id IS NULL OR al.resolved_at IS NOT NULL
    OR al.message NOT LIKE 'Context system hourly check: 2 of 14 rows red at % Perth on % (rows 2, 5).'
    OR run.red_rows <> '{2,5}' OR run.red_lanes <> '{2:lane_2,5:lane_5}'::text[]
    OR run.red_lane_values <> '[{"row": 2, "lane": "lane_2", "unit": "things", "value": "2 things", "number": 2},
                                {"row": 5, "lane": "lane_5", "unit": "things", "value": "5 things", "number": 5}]'::jsonb
    OR (run.row_status->1)->'red_lanes' <> '["lane_2"]' OR (run.row_status->0)->'red_lanes' <> '[]'
    OR al.detail_json->'alarm_keys' <> '["lane_quiet"]' OR al.detail_json->'red_lanes' <> '["2:lane_2", "5:lane_5"]' THEN
  RAISE EXCEPTION 'hourly contract: first red rows not raised as one alert: % %', r, row_to_json(al);
 END IF;
 -- b. The same rows: the open alert is refreshed in place, no new row.
 r := pg_temp.hourly_run('{2,5}');
 SELECT * INTO run FROM public.context_scorecard_runs ORDER BY id DESC LIMIT 1;
 IF r->>'action' <> 'kept' OR (r->>'alert_id')::uuid <> a1
    OR (SELECT count(*) FROM public.ai_alerts WHERE alert_type = 'context_scorecard_red_rows') <> 1
    OR (SELECT (detail_json->>'run_id')::bigint FROM public.ai_alerts WHERE id = a1) <> run.id THEN
  RAISE EXCEPTION 'hourly contract: unchanged red rows did not keep and refresh the open alert: %', r;
 END IF;
 -- c. Amber rows are not reported; they change nothing about the red rows.
 r := pg_temp.hourly_run('{2,5}', '{3,4}');
 IF r->>'action' <> 'kept' THEN RAISE EXCEPTION 'hourly contract: amber rows changed the report: %', r; END IF;
 -- d. daily-digest closes every open ai_alerts row on a full run: the next run raises a new one.
 UPDATE public.ai_alerts SET resolved_at = now() WHERE resolved_at IS NULL AND dismissed_at IS NULL;
 INSERT INTO public.ai_alerts (alert_type, severity, message) VALUES ('cash_overdue_fixture', 'red', 'fixture: another writer''s alert')
 RETURNING id INTO other;
 r := pg_temp.hourly_run('{2,5}');
 a2 := (r->>'alert_id')::uuid;
 IF r->>'action' <> 'raised' OR r->>'previous_state' <> 'resolved' OR a2 = a1
    OR (SELECT count(*) FROM public.ai_alerts WHERE alert_type = 'context_scorecard_red_rows' AND resolved_at IS NULL AND dismissed_at IS NULL) <> 1 THEN
  RAISE EXCEPTION 'hourly contract: an alert closed elsewhere was not raised again: %', r;
 END IF;
 -- e. A person dismissed it: the same rows are held for 24 hours.
 UPDATE public.ai_alerts SET dismissed_at = now() WHERE id = a2;
 r := pg_temp.hourly_run('{2,5}');
 IF r->>'action' <> 'held_dismissed' OR (r->>'alert_id')::uuid <> a2
    OR (SELECT count(*) FROM public.ai_alerts WHERE alert_type = 'context_scorecard_red_rows') <> 2 THEN
  RAISE EXCEPTION 'hourly contract: a dismissal of the same red rows was not held: %', r;
 END IF;
 -- f. After the quiet hours, the same rows are raised again (a reminder).
 UPDATE public.ai_alerts SET dismissed_at = now() - interval '25 hours' WHERE id = a2;
 r := pg_temp.hourly_run('{2,5}');
 a3 := (r->>'alert_id')::uuid;
 IF r->>'action' <> 'raised' OR r->>'previous_state' <> 'dismissed' OR a3 IN (a1, a2) THEN
  RAISE EXCEPTION 'hourly contract: red rows past the dismissal quiet hours were not raised again: %', r;
 END IF;
 -- g. Different red rows: a new alert, the old one closed (superseded).
 r := pg_temp.hourly_run('{2,5,7}');
 a4 := (r->>'alert_id')::uuid;
 IF r->>'action' <> 'raised' OR (r->>'previous_alert_id')::uuid <> a3
    OR (SELECT resolved_at FROM public.ai_alerts WHERE id = a3) IS NULL
    OR (SELECT message FROM public.ai_alerts WHERE id = a4) NOT LIKE '% 3 of 14 rows red % (rows 2, 5, 7).' THEN
  RAISE EXCEPTION 'hourly contract: changed red rows did not supersede the open alert: %', r;
 END IF;
 -- h. A dismissal never holds different rows.
 UPDATE public.ai_alerts SET dismissed_at = now() WHERE id = a4;
 r := pg_temp.hourly_run('{5,7}');
 a5 := (r->>'alert_id')::uuid;
 IF r->>'action' <> 'raised' OR a5 = a4 THEN
  RAISE EXCEPTION 'hourly contract: a dismissal held different red rows: %', r;
 END IF;
 -- i. No red row: the open alert closes itself and nothing new is raised.
 r := pg_temp.hourly_run('{}', '{1}');
 IF r->>'action' <> 'resolved' OR (r->>'alert_id')::uuid <> a5 OR (SELECT resolved_at FROM public.ai_alerts WHERE id = a5) IS NULL
    OR EXISTS (SELECT 1 FROM public.ai_alerts WHERE alert_type = 'context_scorecard_red_rows' AND resolved_at IS NULL AND dismissed_at IS NULL) THEN
  RAISE EXCEPTION 'hourly contract: no red row did not close the open alert: %', r;
 END IF;
 r := pg_temp.hourly_run('{}');
 IF r->>'action' <> 'none' OR r ? 'alert_id' THEN RAISE EXCEPTION 'hourly contract: an all-clear run wrote a report: %', r; END IF;
 -- j. Another writer's alert is never touched; five of this check's alerts were raised, none left open.
 IF (SELECT resolved_at FROM public.ai_alerts WHERE id = other) IS NOT NULL
    OR (SELECT count(*) FROM public.ai_alerts WHERE alert_type = 'context_scorecard_red_rows') <> 5 THEN
  RAISE EXCEPTION 'hourly contract: alerts wrong after the run sequence: %',
   (SELECT jsonb_agg(jsonb_build_object('type', alert_type, 'resolved', resolved_at IS NOT NULL, 'dismissed', dismissed_at IS NOT NULL)) FROM public.ai_alerts);
 END IF;
 -- k. Every run of the sequence was stored ok, one row each.
 IF (SELECT count(*) FROM public.context_scorecard_runs WHERE status = 'ok') <> 10 THEN
  RAISE EXCEPTION 'hourly contract: expected ten ok runs, found %', (SELECT count(*) FROM public.context_scorecard_runs);
 END IF;
END $report$;
-- k2. A person resolving it under their name is an acknowledgement too: the
--     same rows are held; daily-digest's sweep (no name) is not.
DO $ack$
DECLARE r jsonb; a6 uuid;
BEGIN
 r := pg_temp.hourly_run('{9}');
 a6 := (r->>'alert_id')::uuid;
 IF r->>'action' <> 'raised' THEN RAISE EXCEPTION 'hourly contract: new red rows were not raised: %', r; END IF;
 UPDATE public.ai_alerts SET resolved_at = now(), resolved_by = '5c0e0000-0000-4000-8000-0000000000aa' WHERE id = a6;
 r := pg_temp.hourly_run('{9}');
 IF r->>'action' <> 'held_dismissed' OR r->>'previous_state' <> 'resolved_by_person' OR (r->>'alert_id')::uuid <> a6 THEN
  RAISE EXCEPTION 'hourly contract: a person''s resolution of the same red rows was not held: %', r;
 END IF;
END $ack$;
-- l. A report that cannot be written leaves the run ok and says so; the status reads it as not reported.
ALTER TABLE public.ai_alerts ADD CONSTRAINT hourly_contract_no_insert CHECK (alert_type <> 'context_scorecard_red_rows') NOT VALID;
DO $$
DECLARE r jsonb;
BEGIN
 r := pg_temp.hourly_run('{4}');
 IF r->>'action' <> 'failed' OR r->>'error_code' <> '23514'
    OR (SELECT status FROM public.context_scorecard_runs ORDER BY id DESC LIMIT 1) <> 'ok' THEN
  RAISE EXCEPTION 'hourly contract: a report that could not be written was not recorded as failed: %', r;
 END IF;
 IF position('were not reported (23514)' IN public.context_scorecard_run_status()->'lane'->>'note') = 0 THEN
  RAISE EXCEPTION 'hourly contract: the status did not read an unwritten report as not reported: %', public.context_scorecard_run_status()->'lane';
 END IF;
END $$;
ROLLBACK;

-- 6. Runs past the keep window are deleted by the recorder; newer ones stay.
BEGIN;
INSERT INTO public.context_scorecard_runs (run_trigger, as_of, started_at, finished_at, duration_ms, status, error_code)
VALUES ('cron', now() - interval '181 days', now() - interval '181 days', now() - interval '181 days', 0, 'failed', '57014'),
       ('cron', now() - interval '179 days', now() - interval '179 days', now() - interval '179 days', 0, 'failed', '57014');
DO $$
DECLARE r jsonb := public.context_scorecard_record_run('manual');
BEGIN
 IF (r->>'pruned')::integer <> 1 OR EXISTS (SELECT 1 FROM public.context_scorecard_runs WHERE as_of < now() - interval '180 days')
    OR NOT EXISTS (SELECT 1 FROM public.context_scorecard_runs WHERE as_of = now() - interval '179 days') THEN
  RAISE EXCEPTION 'hourly contract: the keep window is wrong: %', r;
 END IF;
END $$;
ROLLBACK;

-- 7. The status read, graded at pinned instants on fixed runs (12:45 Perth, 7 Oct 2026 = 04:45Z).
BEGIN;
SET LOCAL TimeZone = 'UTC';
-- Without pg_cron the job cannot be checked, which is red: never assumed scheduled.
INSERT INTO public.context_scorecard_runs (run_trigger, as_of, started_at, finished_at, duration_ms, status, scorecard_version, summary, row_status, red_rows, report)
VALUES ('cron', '2026-10-07 04:40Z', '2026-10-07 04:40Z', '2026-10-07 04:40:01Z', 1000, 'ok', 'v', '{}', '[]', '{}', '{"action": "none"}');
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
INSERT INTO public.ai_alerts (id, alert_type, severity, message, detail_json, created_at)
VALUES ('5c0e0000-0000-4000-8000-000000000001', 'context_scorecard_red_rows', 'red', 'fixture', '{"red_rows": [2, 7]}', '2026-10-07 01:40Z');
-- 24 hourly ok runs at minute 40, 6 Oct 05:40Z to 7 Oct 04:40Z; rows 2 and 5 red until 7 Oct 03:40Z, then 2 and 7.
INSERT INTO public.context_scorecard_runs (run_trigger, as_of, started_at, finished_at, duration_ms, status, scorecard_version, live_jobs,
  summary, row_status, red_rows, red_lanes, report)
SELECT 'cron', t, t, t + interval '1 second', 1100, 'ok', 'context-scorecard-v1', 3, '{}', '[]',
  CASE WHEN t < '2026-10-07 04:40Z' THEN '{2,5}'::integer[] ELSE '{2,7}'::integer[] END,
  CASE WHEN t < '2026-10-07 04:40Z' THEN '{2:a,5:b}'::text[] ELSE '{2:a,7:c}'::text[] END,
  '{"action": "kept", "alert_id": "5c0e0000-0000-4000-8000-000000000001"}'::jsonb
FROM generate_series('2026-10-06 05:40Z'::timestamptz, '2026-10-07 04:40Z', interval '1 hour') t;
DO $status$
DECLARE s jsonb;
BEGIN
 -- Green: on time, every hour covered, the job as the policy says, red rows reported.
 s := public.context_scorecard_run_status('2026-10-07 04:45Z');
 IF s->'lane'->>'status' <> 'green' OR (s->'lane'->>'number')::integer <> 0 OR (s->'lane'->>'row')::integer <> 10
    OR s->'lane'->>'lane' <> 'hourly_run' OR (s->'lane'->>'higher_is_better')::boolean
    OR (s->'window'->>'hours_checked')::integer <> 23 OR (s->'window'->>'runs')::integer <> 24
    OR (s->>'last_run_at')::timestamptz <> '2026-10-07 04:40Z' OR (s->'last_run'->>'minutes_ago')::integer <> 5
    OR s->'red_rows' <> '[2, 7]' OR s->'red_lanes' <> '["2:a", "7:c"]'
    OR s->'changes'->'newly_red' <> '[7]' OR s->'changes'->'cleared' <> '[5]'
    OR NOT (s->'cron'->>'readable')::boolean OR NOT (s->'cron'->>'exists')::boolean OR NOT (s->'cron'->>'active')::boolean
    OR NOT (s->'cron'->>'command_matches')::boolean OR NOT (s->'cron'->>'schedule_matches')::boolean
    OR NOT (s->'report'->>'reported')::boolean OR s->'report'->>'alert_state' <> 'open' OR (s->>'consecutive_failures')::integer <> 0
    OR s->'lane'->>'value' NOT LIKE 'newest run 12:40 Perth on 7 Oct, ok in 1100 ms; 0 of 23 hours missed; 2 red rows reported (kept, alert open)' THEN
  RAISE EXCEPTION 'hourly contract: a healthy hourly run did not read green: %', s - 'policy' - 'last_ok_run';
 END IF;
 IF s->'lane'->>'value' ~ '[\u2014\u2013]' OR s->'lane'->>'note' ~ '[\u2014\u2013]' THEN RAISE EXCEPTION 'hourly contract: lane words carry an em or en dash'; END IF;
 -- The instant cuts the runs: later runs are left out.
 s := public.context_scorecard_run_status('2026-10-07 00:45Z');
 IF (s->>'last_run_at')::timestamptz <> '2026-10-07 00:40Z' OR s->'lane'->>'status' <> 'green' OR s->'red_rows' <> '[2, 5]' THEN
  RAISE EXCEPTION 'hourly contract: runs after p_as_of were read: %', s->>'last_run_at';
 END IF;
 -- Late: 80 minutes after the newest run.
 s := public.context_scorecard_run_status('2026-10-07 06:00Z');
 IF s->'lane'->>'status' <> 'red' OR position('late: the newest run was 80 minutes ago' IN s->'lane'->>'note') = 0 THEN
  RAISE EXCEPTION 'hourly contract: a late run did not read red: %', s->'lane';
 END IF;
 -- 74 minutes is within the grace.
 s := public.context_scorecard_run_status('2026-10-07 05:54Z');
 IF s->'lane'->>'status' = 'red' AND position('late' IN s->'lane'->>'note') > 0 THEN
  RAISE EXCEPTION 'hourly contract: a run inside the grace read late: %', s->'lane';
 END IF;
END $status$;
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
-- A failed newest run is red, and failures are counted in a row.
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
END $$;
DELETE FROM public.context_scorecard_runs WHERE status = 'failed';
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
-- A slow run is amber; a run that did not report is red.
UPDATE public.context_scorecard_runs SET duration_ms = 45000 WHERE as_of = '2026-10-07 04:40Z';
DO $$
DECLARE s jsonb;
BEGIN
 s := public.context_scorecard_run_status('2026-10-07 04:45Z');
 IF position('slow: the newest run took 45000 ms' IN s->'lane'->>'note') = 0 THEN
  RAISE EXCEPTION 'hourly contract: a slow run was not named: %', s->'lane';
 END IF;
END $$;
UPDATE public.context_scorecard_runs SET report = '{"action": "failed", "error_code": "42501"}' WHERE as_of = '2026-10-07 04:40Z';
DO $$ BEGIN
 IF public.context_scorecard_run_status('2026-10-07 04:45Z')->'lane'->>'status' <> 'red'
    OR position('were not reported (42501)' IN public.context_scorecard_run_status('2026-10-07 04:45Z')->'lane'->>'note') = 0 THEN
  RAISE EXCEPTION 'hourly contract: unreported red rows did not read red';
 END IF;
END $$;
-- No run at all.
DELETE FROM public.context_scorecard_runs;
DO $$
DECLARE s jsonb := public.context_scorecard_run_status('2026-10-07 04:45Z');
BEGIN
 IF s->'lane'->>'status' <> 'red' OR s->'lane'->'number' <> 'null'::jsonb OR s->'last_run' <> 'null'::jsonb
    OR s->'lane'->>'value' <> 'no hourly run recorded yet' THEN
  RAISE EXCEPTION 'hourly contract: no run did not read red: %', s->'lane';
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

-- 9. The rollback, inside a rolled-back transaction: unschedules, closes the
--    open report (keeps the rows), drops the four objects, leaves the rest.
BEGIN;
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, schedule text NOT NULL, command text NOT NULL, active boolean NOT NULL DEFAULT true, jobname text);
CREATE FUNCTION cron.unschedule(job_name text) RETURNS boolean LANGUAGE sql AS $$
 WITH d AS (DELETE FROM cron.job WHERE jobname = job_name RETURNING 1) SELECT count(*) > 0 FROM d
$$;
INSERT INTO cron.job (jobname, schedule, command)
SELECT p->>'cron_job', p->>'schedule', p->>'command' FROM (SELECT public.context_scorecard_run_policy() AS p) x;
INSERT INTO cron.job (jobname, schedule, command) VALUES ('another-job', '* * * * *', 'SELECT 1');
INSERT INTO public.ai_alerts (id, alert_type, severity, message) VALUES
 ('5c0e0000-0000-4000-8000-000000000002', 'context_scorecard_red_rows', 'red', 'fixture: open report'),
 ('5c0e0000-0000-4000-8000-000000000003', 'cash_overdue_fixture', 'red', 'fixture: another writer''s alert');
\ir ../../../rollbacks/20261007040000_context_scorecard_hourly_down.sql
DO $$
BEGIN
 IF to_regprocedure('public.context_scorecard_run_status(timestamptz)') IS NOT NULL OR to_regprocedure('public.context_scorecard_record_run(text)') IS NOT NULL
    OR to_regprocedure('public.context_scorecard_run_policy()') IS NOT NULL OR to_regclass('public.context_scorecard_runs') IS NOT NULL THEN
  RAISE EXCEPTION 'hourly contract: the rollback left an object behind';
 END IF;
 IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'context-scorecard-hourly') OR NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'another-job') THEN
  RAISE EXCEPTION 'hourly contract: the rollback unscheduled the wrong jobs';
 END IF;
 IF (SELECT resolved_at FROM public.ai_alerts WHERE id = '5c0e0000-0000-4000-8000-000000000002') IS NULL
    OR (SELECT resolved_at FROM public.ai_alerts WHERE id = '5c0e0000-0000-4000-8000-000000000003') IS NOT NULL THEN
  RAISE EXCEPTION 'hourly contract: the rollback closed the wrong alerts';
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
 IF to_regprocedure('public.context_scorecard_run_status(timestamptz)') IS NULL OR to_regclass('public.context_scorecard_runs') IS NULL THEN
  RAISE EXCEPTION 'hourly contract: the refused rollback dropped something';
 END IF;
END $$;
