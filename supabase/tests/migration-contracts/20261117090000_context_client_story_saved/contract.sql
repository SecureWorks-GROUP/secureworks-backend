-- Contract for 20261117090000_context_client_story_saved (ticket P0-01): the client story never
-- builds a job story. One client ask used to build a full story for each of the client's newest
-- 20 jobs; now each job's now line is its saved story's headline as current at the asked instant,
-- phase is null, open_loops is empty and not_known says to ask the job story.
--  1. No build: with every job story read made to fail, the client story of a 22-job client
--     still answers, whole.
--  2. The saved headline: the story current at p_as_of, never a later or superseded one.
--  3. Shape: version, keys, flags, grants, comment.
--  4. Re-applying the migration changes nothing.
BEGIN;
-- 1. Every job story read (and the assembler) now raises: any call from the client story fails it.
DO $nobuild$
DECLARE a record;
BEGIN
 FOR a IN SELECT p.proname, pg_get_function_arguments(p.oid) AS args FROM pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('context_job_story', 'context_job_story_assemble') LOOP
  EXECUTE format('CREATE OR REPLACE FUNCTION public.%I(%s) RETURNS jsonb LANGUAGE plpgsql AS $b$ BEGIN '
                 'RAISE EXCEPTION ''client story saved contract: the client story built a job story''; END $b$', a.proname, a.args);
 END LOOP;
END $nobuild$;

SET LOCAL session_replication_role = replica;
-- 22 jobs of one CRM contact, newest last; job 22 is the one asked about.
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, client_email, ghl_contact_id, xero_contact_id, pricing_json, created_at)
SELECT ('11709000-0000-4000-8000-0000000000' || lpad(g::text, 2, '0'))::uuid, '00000000-0000-4000-8000-0000000000aa',
       'SWF-T9' || lpad(g::text, 3, '0'), CASE WHEN g % 2 = 0 THEN 'quoted' ELSE 'archived' END, 'fencing', 'Saved Client',
       'saved.client@example.test', 'ct1709', NULL, '{}', '2026-09-01 01:00Z'::timestamptz + g * interval '1 day'
FROM generate_series(1, 22) g;
-- Job 22: an older story superseded on 5 Nov, the current one written then; a story on job 21 that
-- was written after the asked instant.
INSERT INTO public.context_job_story_texts (job_id, written_at, checked_at, card_hash, model, sections, status, superseded_at)
VALUES
 ('11709000-0000-4000-8000-000000000022', '2026-11-01 01:00Z', '2026-11-01 01:00Z', md5('v1'), 'luna-story',
  '{"headline":"Quote sent, waiting on the customer.","the_job":"A fence.","how_we_got_here":"Quoted.","where_it_is_at":"Waiting.","watch_out":"Nothing."}',
  'superseded', '2026-11-05 01:00Z'),
 ('11709000-0000-4000-8000-000000000022', '2026-11-05 01:00Z', '2026-11-06 01:00Z', md5('v2'), 'luna-story',
  '{"headline":"Customer accepted; deposit invoice next.","the_job":"A fence.","how_we_got_here":"Accepted.","where_it_is_at":"Deposit.","watch_out":"Nothing."}',
  'current', NULL),
 ('11709000-0000-4000-8000-000000000021', '2026-11-20 01:00Z', '2026-11-20 01:00Z', md5('v3'), 'luna-story',
  '{"headline":"Written after the asked instant.","the_job":"A fence.","how_we_got_here":"Later.","where_it_is_at":"Later.","watch_out":"Nothing."}',
  'current', NULL);
SET LOCAL session_replication_role = origin;

DO $saved$
DECLARE s jsonb; j jsonb; asof constant timestamptz := '2026-11-10 02:00Z';
BEGIN
 s := public.context_client_story('11709000-0000-4000-8000-000000000022', asof);
 IF s IS NULL OR s->>'version' <> 'client-story-v1' OR jsonb_array_length(s->'jobs') <> 22 THEN
  RAISE EXCEPTION 'client story saved contract: every job of the client is listed: %', s->'jobs';
 END IF;
 IF s->'open_loops' <> '[]'::jsonb THEN
  RAISE EXCEPTION 'client story saved contract: no open items without a job story build: %', s->'open_loops';
 END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(s->'jobs') x
            WHERE NOT (x ?& ARRAY['job_id', 'job_number', 'type', 'status', 'live', 'created_at', 'phase', 'now', 'now_source',
                                  'story_written_at', 'story_checked_at', 'owing', 'overdue', 'owed_by_others', 'cites'])
               OR x->'phase' <> 'null'::jsonb) THEN
  RAISE EXCEPTION 'client story saved contract: every job keeps its keys, phase null: %', s->'jobs';
 END IF;
 IF NOT (s ?& ARRAY['version', 'as_of', 'job_id', 'identity', 'jobs', 'money', 'open_loops', 'past_issues', 'preferences', 'other_parties', 'not_known']) THEN
  RAISE EXCEPTION 'client story saved contract: the answer keeps every key: %', s;
 END IF;
 -- 2. The saved headline current at the instant asked
 SELECT x INTO j FROM jsonb_array_elements(s->'jobs') x WHERE x->>'job_number' = 'SWF-T9022';
 IF j->>'now' IS DISTINCT FROM 'Customer accepted; deposit invoice next.' OR j->>'now_source' IS DISTINCT FROM 'saved_story'
    OR (j->>'story_written_at')::timestamptz IS DISTINCT FROM '2026-11-05 01:00Z'::timestamptz
    OR (j->>'story_checked_at')::timestamptz IS DISTINCT FROM '2026-11-06 01:00Z'::timestamptz THEN
  RAISE EXCEPTION 'client story saved contract: the now line is the saved story current then: %', j;
 END IF;
 SELECT x INTO j FROM jsonb_array_elements(s->'jobs') x WHERE x->>'job_number' = 'SWF-T9021';
 IF j->'now' <> 'null'::jsonb OR j->'now_source' <> 'null'::jsonb OR j->'story_written_at' <> 'null'::jsonb THEN
  RAISE EXCEPTION 'client story saved contract: a story written after the instant is not read: %', j;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'not_known') k
                WHERE k->>'what' = 'Phase and open items on this client''s jobs are not listed here; ask the job story for a job to see them.')
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'not_known') k WHERE k->>'what' = 'Jobs with no saved story: 21; their now line is empty.')
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(s->'not_known') k WHERE k->>'what' LIKE '%without a full story%') THEN
  RAISE EXCEPTION 'client story saved contract: not_known says what the job story holds: %', s->'not_known';
 END IF;
 -- Asked as of 3 Nov, the story current then (the one superseded on 5 Nov) is read.
 s := public.context_client_story('11709000-0000-4000-8000-000000000022', '2026-11-03 02:00Z');
 SELECT x INTO j FROM jsonb_array_elements(s->'jobs') x WHERE x->>'job_number' = 'SWF-T9022';
 IF j->>'now' IS DISTINCT FROM 'Quote sent, waiting on the customer.' THEN
  RAISE EXCEPTION 'client story saved contract: an earlier instant reads the story current then: %', j;
 END IF;
END $saved$;
ROLLBACK;

-- 3. Shape: flags, grants and comment as story safety left them; the new body is live.
DO $shape$
DECLARE p record; sig constant text := 'public.context_client_story(uuid,timestamptz)';
BEGIN
 SELECT pr.prosecdef, pr.provolatile, pr.proconfig, md5(pr.prosrc) AS m INTO p FROM pg_proc pr WHERE pr.oid = to_regprocedure(sig);
 IF p IS NULL OR NOT p.prosecdef OR p.provolatile <> 's' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
    OR p.m IS DISTINCT FROM 'ccce1009b2487423ce2a3425a190204f' THEN
  RAISE EXCEPTION 'client story saved contract: flags or body wrong (%)', p;
 END IF;
 IF has_function_privilege('anon', sig, 'EXECUTE') OR has_function_privilege('authenticated', sig, 'EXECUTE')
    OR NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN
  RAISE EXCEPTION 'client story saved contract: service role only';
 END IF;
 IF coalesce(obj_description(to_regprocedure(sig), 'pg_proc'), '')
    NOT LIKE 'Job story (20261006014000), story fixes (20261006033000), story safety (20261006040000): (client story saved, 20261117090000)%' THEN
  RAISE EXCEPTION 'client story saved contract: the comment keeps the slice names first and names this slice';
 END IF;
 IF position('context_job_story(' IN (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(sig))) > 0 THEN
  RAISE EXCEPTION 'client story saved contract: the body names the job story read';
 END IF;
END $shape$;

-- 4. Re-applying the migration changes nothing.
BEGIN;
\ir ../../../migrations/20261117090000_context_client_story_saved.sql
DO $again$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_client_story(uuid,timestamptz)'::regprocedure)
    IS DISTINCT FROM 'ccce1009b2487423ce2a3425a190204f' THEN
  RAISE EXCEPTION 'client story saved contract: a re-apply must change nothing';
 END IF;
END $again$;
ROLLBACK;
