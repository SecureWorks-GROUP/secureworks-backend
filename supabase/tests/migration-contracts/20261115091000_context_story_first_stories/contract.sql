\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.first_assert(n text, p boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF p IS DISTINCT FROM true THEN RAISE EXCEPTION 'first stories contract: %', n; END IF;
END $$;
DO $test$
DECLARE org uuid := '00000000-0000-0000-0000-000000000001';
 a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid(); d uuid := gen_random_uuid();
 e uuid := gen_random_uuid(); f uuid := gen_random_uuid(); h uuid := gen_random_uuid(); a2 uuid := gen_random_uuid();
 g uuid := gen_random_uuid(); e2 uuid := gen_random_uuid(); s uuid := gen_random_uuid();
 r jsonb; w jsonb; k integer; x uuid; perth date := (clock_timestamp() AT TIME ZONE 'Australia/Perth')::date;
 sections jsonb := '{"headline":"Fixture job.","the_job":"Fixture fence.","how_we_got_here":"Fixture preparation.","where_it_is_at":"Awaiting work.","watch_out":"Costs unknown."}';
BEGIN
 UPDATE automation_switches SET all_stop = false, extraction = true WHERE id = 1;
 -- The day's calls: nothing used, and the day's cap far above the ledger's reserve lines whatever the hour.
 UPDATE context_ledger_settings SET calls_per_day = 3000, live_reserve_calls = 50, live_reserve_calls_morning = 50;
 DELETE FROM context_model_call_reservations WHERE run_date = perth;
 DELETE FROM context_job_story_requests;
 -- a: live job, live notes, never written. a2: the same, read earlier. b: has a current story. c: archived.
 -- d: holding job. e: its last request failed after its notes last changed. f: no live notes. h: draft.
 -- g: a quoted lead gone quiet (the lead rule refuses it) holding the newest reading. e2: failed an hour ago, notes
 -- moved since. s: only a shadow reading.
 INSERT INTO jobs (id, org_id, status, type, job_number, client_name, metadata, created_at) VALUES
  (a,  org, 'in_progress', 'fencing', 'SWF-FIRST-A',  'Synthetic first story A',  '{}', '2026-09-01'),
  (a2, org, 'scheduled',   'fencing', 'SWF-FIRST-A2', 'Synthetic first story A2', '{}', '2026-09-01'),
  (b,  org, 'in_progress', 'fencing', 'SWF-FIRST-B',  'Synthetic first story B',  '{}', '2026-09-01'),
  (c,  org, 'archived',    'fencing', 'SWF-FIRST-C',  'Synthetic first story C',  '{}', '2026-09-01'),
  (d,  org, 'in_progress', 'fencing', 'SWF-FIRST-D',  'Synthetic first story D',  '{"do_not_schedule":"true"}', '2026-09-01'),
  (e,  org, 'in_progress', 'fencing', 'SWF-FIRST-E',  'Synthetic first story E',  '{}', '2026-09-01'),
  (f,  org, 'in_progress', 'fencing', 'SWF-FIRST-F',  'Synthetic first story F',  '{}', '2026-09-01'),
  (h,  org, 'draft',       'fencing', 'SWF-FIRST-H',  'Synthetic first story H',  '{}', '2026-09-01'),
  (g,  org, 'quoted',      'fencing', 'SWF-FIRST-G',  'Synthetic first story G',  '{}', '2026-06-01'),
  (e2, org, 'in_progress', 'fencing', 'SWF-FIRST-E2', 'Synthetic first story E2', '{}', '2026-09-01'),
  (s,  org, 'in_progress', 'fencing', 'SWF-FIRST-S',  'Synthetic first story S',  '{}', '2026-09-01');
 UPDATE jobs SET quoted_at = now() - interval '90 days' WHERE id = g;
 FOREACH x IN ARRAY ARRAY[a, a2, b, c, d, e, h, g, e2] LOOP
  INSERT INTO context_ledger_generations (job_id, kind, status, reader, promoted_at, evidence_until, checks)
  VALUES (x, 'backfill', 'live', 'luna-ledger:v8-finance1', now() - interval '3 days',
          now() - CASE WHEN x = g THEN interval '1 minute' WHEN x = a THEN interval '1 hour' ELSE interval '2 days' END, '{}');
 END LOOP;
 INSERT INTO context_ledger_generations (job_id, kind, status, reader, evidence_until, checks)
 VALUES (s, 'backfill', 'shadow', 'luna-ledger:v8-finance1', now() - interval '5 minutes', '{}');
 UPDATE context_ledger_generations SET updated_at = now() - interval '3 days' WHERE job_id = e;
 -- e2: only the backoff holds it (its notes moved after the failure).
 INSERT INTO context_job_story_requests (job_id, requested_by, reason, requested_at, picked_at, done_at, outcome, error)
 VALUES (e2, 'fixture', 'asked', now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour', 'failed', 'fact_check_failed');
 PERFORM pg_temp.first_assert('fixture: the lead rule refuses the quiet quoted lead',
  NOT (SELECT m.monitored FROM context_lead_monitored_jobs(ARRAY[g], now()) m));
 INSERT INTO context_job_story_requests (job_id, requested_by, reason, requested_at, picked_at, done_at, outcome, error)
 VALUES (e, 'fixture', 'asked', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days', 'failed', 'fact_check_failed');
 UPDATE feature_flags SET enabled = true WHERE flag_name = 'context_job_story_text_v1';
 w := context_job_story_writer_input(b);
 INSERT INTO context_job_story_texts (job_id, checked_at, job_status, card_hash, record_sig, model, sections, checks, written_at)
 VALUES (b, now() - interval '1 hour', 'in_progress', w ->> 'card_hash', context_job_story_record_sig(b), 'fixture-model', sections,
         jsonb_build_object('writer', 'fixture-first'), now() - interval '1 hour');

 -- Off: nothing is queued.
 UPDATE feature_flags SET enabled = false WHERE flag_name = 'context_job_story_text_v1';
 r := context_job_story_enqueue_first(5);
 PERFORM pg_temp.first_assert('switch off queues nothing', r ->> 'outcome' = 'off' AND (r ->> 'queued')::integer = 0
  AND NOT EXISTS (SELECT 1 FROM context_job_story_requests WHERE done_at IS NULL));
 UPDATE feature_flags SET enabled = true WHERE flag_name = 'context_job_story_text_v1';

 -- One at a time: the most recently read job first. The refused lead holds the newest reading and still never
 -- holds the head of the order.
 r := context_job_story_enqueue_first(1);
 PERFORM pg_temp.first_assert('most recently read first, past a refused lead', r -> 'job_ids' = jsonb_build_array(a) AND (r ->> 'candidates')::integer = 3);
 PERFORM pg_temp.first_assert('queued as the first-story writer', EXISTS (SELECT 1 FROM context_job_story_requests
  WHERE job_id = a AND done_at IS NULL AND reason = 'job_changed' AND requested_by = 'luna-story-first'));
 -- The rest: only a2. Never the job with a story, the archived, holding or draft job, the one with no live notes
 -- or only a shadow reading, the refused lead, the one that failed since its notes last changed, or the one that
 -- failed inside the backoff.
 r := context_job_story_enqueue_first(NULL);
 PERFORM pg_temp.first_assert('only the other unwritten live job', r -> 'job_ids' = jsonb_build_array(a2));
 r := context_job_story_enqueue_first(5);
 PERFORM pg_temp.first_assert('an open request is not queued twice (only the refused lead is left)', (r ->> 'queued')::integer = 0 AND (r ->> 'candidates')::integer = 1);
 PERFORM pg_temp.first_assert('excluded jobs hold no request', NOT EXISTS (SELECT 1 FROM context_job_story_requests
  WHERE job_id IN (b, c, d, f, h, g, s) OR (job_id IN (e, e2) AND done_at IS NULL)));

 -- A failed job is tried again once its notes have moved and the backoff has passed.
 UPDATE context_ledger_generations SET updated_at = now() WHERE job_id = e;
 r := context_job_story_enqueue_first(5);
 PERFORM pg_temp.first_assert('failed job returns after its notes move', r -> 'job_ids' = jsonb_build_array(e));
 UPDATE context_job_story_requests SET done_at = now(), outcome = 'failed', error = 'fact_check_failed', picked_at = now() WHERE job_id = e AND done_at IS NULL;
 r := context_job_story_enqueue_first(5);
 PERFORM pg_temp.first_assert('a fresh failure backs off', (r ->> 'queued')::integer = 0);

 -- First stories never fill past first_open_max open requests.
 DELETE FROM context_job_story_requests WHERE job_id IN (a, a2);
 FOR k IN 1..4 LOOP
  x := gen_random_uuid();
  INSERT INTO jobs (id, org_id, status, type, job_number, client_name, metadata, created_at)
  VALUES (x, org, 'in_progress', 'fencing', 'SWF-FIRST-O' || k, 'Synthetic open request', '{}', '2026-09-01');
  INSERT INTO context_job_story_requests (job_id, requested_by, reason) VALUES (x, 'fixture', 'asked');
 END LOOP;
 r := context_job_story_enqueue_first(5);
 PERFORM pg_temp.first_assert('fills only the room left', (r ->> 'queued')::integer = 1 AND r -> 'job_ids' = jsonb_build_array(a));
 r := context_job_story_enqueue_first(5);
 PERFORM pg_temp.first_assert('full queue takes none', r ->> 'outcome' = 'queued' AND (r ->> 'queued')::integer = 0);

 -- The day's story calls: first stories stop at the reserve and take only what is above it.
 DELETE FROM context_job_story_requests WHERE done_at IS NULL;
 INSERT INTO context_model_call_reservations (run_date, ordinal, phase, reserved_at)
 SELECT perth, n, 'story', now() FROM generate_series(1, 179) n;
 r := context_job_story_enqueue_first(5);
 PERFORM pg_temp.first_assert('one call above the reserve queues one', (r ->> 'queued')::integer = 1 AND r -> 'job_ids' = jsonb_build_array(a));
 DELETE FROM context_job_story_requests WHERE done_at IS NULL;
 INSERT INTO context_model_call_reservations (run_date, ordinal, phase, reserved_at) VALUES (perth, 180, 'story', now());
 r := context_job_story_enqueue_first(5);
 PERFORM pg_temp.first_assert('at the reserve nothing is queued', r ->> 'outcome' = 'reserve' AND (r ->> 'queued')::integer = 0
  AND r ->> 'reason' = 'first_story_reserve' AND NOT EXISTS (SELECT 1 FROM context_job_story_requests WHERE done_at IS NULL));
 UPDATE automation_switches SET extraction = false WHERE id = 1;
 DELETE FROM context_model_call_reservations WHERE run_date = perth;
 r := context_job_story_enqueue_first(5);
 PERFORM pg_temp.first_assert('lane off queues nothing', r ->> 'outcome' = 'reserve' AND r ->> 'reason' = 'lane_off' AND (r ->> 'queued')::integer = 0);
 UPDATE automation_switches SET extraction = true WHERE id = 1;

 PERFORM pg_temp.first_assert('the policy carries the two numbers', context_job_story_first_policy() = '{"version":"job-story-first-v1","reserve_calls":60,"first_open_max":5}'::jsonb
  AND NOT has_function_privilege('anon', 'public.context_job_story_first_policy()', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.context_job_story_first_policy()', 'EXECUTE'));
 PERFORM pg_temp.first_assert('service role only',
  NOT has_function_privilege('anon', 'public.context_job_story_enqueue_first(integer)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.context_job_story_enqueue_first(integer)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.context_job_story_enqueue_first(integer)', 'EXECUTE'));
 PERFORM pg_temp.first_assert('comment names its slice', obj_description('public.context_job_story_enqueue_first(integer)'::regprocedure) LIKE 'Job story first stories (20261115091000)%');
END
$test$;
ROLLBACK;
