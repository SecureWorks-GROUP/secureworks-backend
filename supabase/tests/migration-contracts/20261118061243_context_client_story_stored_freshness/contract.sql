BEGIN;
SET LOCAL statement_timeout = '120s';
\ir ../../../migrations/20261117171304_job_pages.sql
\ir ../../../migrations/20261117172503_job_pages_queue_safety.sql
\ir ../../../migrations/20261118041726_context_client_story_stored.sql

-- Calling the live story builder must fail through the installed entry point.
DO $poison$
DECLARE args text;
BEGIN
 FOR args IN SELECT pg_get_function_arguments(oid) FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'context_job_story'
 LOOP
  EXECUTE format('CREATE OR REPLACE FUNCTION public.context_job_story(%s)
   RETURNS jsonb LANGUAGE plpgsql AS $s$ BEGIN RAISE query_canceled; END $s$', args);
 END LOOP;
END $poison$;

SET LOCAL session_replication_role = replica;
UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'context_record_close_v1';
INSERT INTO public.jobs(id, org_id, job_number, type, status, created_at, ghl_contact_id, pricing_json)
 SELECT ('00000104-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
        '00000000-0000-4000-8000-0000000000aa', 'ZZTEST-1566-' || n, 'fencing', 'accepted',
        now() - interval '30 days' + n * interval '1 minute',
        CASE WHEN n <= 5 THEN 'ZZTEST-1566' END, '{}'
 FROM generate_series(1, 512) n;
INSERT INTO public.context_job_story_texts(job_id, written_at, checked_at, sections, status, card_hash, model)
 SELECT id, now() - interval '2 days', now() - interval '1 day',
        '{"headline":"ZZTEST saved headline","the_job":"ZZTEST","how_we_got_here":"ZZTEST","where_it_is_at":"ZZTEST","watch_out":"ZZTEST"}',
        'current', md5('ZZTEST'), 'luna-story'
 FROM public.jobs WHERE ghl_contact_id = 'ZZTEST-1566';
SET LOCAL session_replication_role = origin;

-- Give the planner an estate with unrelated pages, folded marks and mark events.
INSERT INTO public.job_change_marks_base(job_id)
 SELECT id FROM public.jobs
 WHERE job_number LIKE 'ZZTEST-1566-%' AND ghl_contact_id IS NULL;
SELECT count(public.job_mark_changed(id, 'office')) FROM public.jobs
 WHERE job_number LIKE 'ZZTEST-1566-%' AND job_number <> 'ZZTEST-1566-5';
INSERT INTO public.job_pages(job_id, page, built_at, covers_mark_version, build_ms, status)
 SELECT j.id, jsonb_build_object('summary', jsonb_build_object('phase', 'install',
     'loops', jsonb_build_array(jsonb_build_object('key', 'ZZTEST:' || j.job_number, 'rank', 1, 'status', 'open')))),
     now(), m.mark_version, 0, CASE WHEN j.job_number = 'ZZTEST-1566-3' THEN 'failed' ELSE 'ready' END
 FROM public.jobs j LEFT JOIN public.job_change_marks m ON m.job_id = j.id
 WHERE j.job_number LIKE 'ZZTEST-1566-%' AND j.job_number <> 'ZZTEST-1566-4';
SELECT public.job_mark_changed('00000104-0000-4000-8000-000000000002', 'office');

ANALYZE public.jobs;
ANALYZE public.job_pages;
ANALYZE public.job_change_marks_base;
ANALYZE public.job_change_mark_events;

CREATE TEMP TABLE p0013_freshness_before AS
 SELECT public.context_client_story('00000104-0000-4000-8000-000000000002') AS current_answer,
        public.context_client_story('00000104-0000-4000-8000-000000000002', now() - interval '1 day') AS past_answer;

\ir ../../../migrations/20261118061243_context_client_story_stored_freshness.sql
\ir ../../../migrations/20261118061243_context_client_story_stored_freshness.sql

DO $inactive$
BEGIN
 IF public.context_client_story('00000104-0000-4000-8000-000000000002')
    IS DISTINCT FROM (SELECT current_answer FROM p0013_freshness_before) THEN
  RAISE EXCEPTION 'P0-01.3 follow-up: applying the migration changed the answer before install';
 END IF;
END $inactive$;

SELECT public.install_context_client_story_stored();

DO $current$
DECLARE
 stale_job_id uuid := '00000104-0000-4000-8000-000000000002';
 answer jsonb := public.context_client_story(stale_job_id, now() - interval '10 minutes');
BEGIN
 IF public.job_page_get(stale_job_id)->>'stale' IS DISTINCT FROM 'true' THEN
  RAISE EXCEPTION 'P0-01.3 follow-up: fixture page did not become stale after the office change';
 END IF;
 IF (SELECT array_agg(j->>'job_number' ORDER BY j->>'job_number') FROM jsonb_array_elements(answer->'jobs') j
     WHERE j->>'phase' = 'install') IS DISTINCT FROM ARRAY['ZZTEST-1566-1', 'ZZTEST-1566-5']
    OR (SELECT array_agg(l->>'job_number' ORDER BY l->>'job_number') FROM jsonb_array_elements(answer->'open_loops') l)
       IS DISTINCT FROM ARRAY['ZZTEST-1566-1', 'ZZTEST-1566-5']
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(answer->'not_known') k
       WHERE k->>'what' = '3 of this client''s jobs have no stored page yet; open the job to build it.')
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(answer->'jobs') j
       WHERE j->>'now' IS DISTINCT FROM 'ZZTEST saved headline' OR j->>'now_source' IS DISTINCT FROM 'saved_story') THEN
  RAISE EXCEPTION 'P0-01.3 follow-up: stale/failed/missing pages must leave saved headlines and give no phase or open items';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.job_pages jp WHERE jp.job_id = stale_job_id
                AND jp.status = 'ready' AND jp.page #>> '{summary,phase}' = 'install')
    OR EXISTS (SELECT 1 FROM public.job_pages jp WHERE jp.job_id = '00000104-0000-4000-8000-000000000004') THEN
  RAISE EXCEPTION 'P0-01.3 follow-up: the client read changed stored pages';
 END IF;
END $current$;

DO $past$
BEGIN
 IF public.context_client_story('00000104-0000-4000-8000-000000000002', now() - interval '1 day')
    IS DISTINCT FROM (SELECT past_answer FROM p0013_freshness_before) THEN
  RAISE EXCEPTION 'P0-01.3 follow-up: a past request must return the exact saved-text answer';
 END IF;
END $past$;

ALTER TABLE public.job_pages RENAME TO p0013_freshness_unreadable_pages;
DO $unreadable$
BEGIN
 IF public.context_client_story('00000104-0000-4000-8000-000000000002')
    IS DISTINCT FROM (SELECT current_answer FROM p0013_freshness_before)
    OR public.context_client_story_stored('00000104-0000-4000-8000-000000000002', now() - interval '1 day')
    IS DISTINCT FROM (SELECT past_answer FROM p0013_freshness_before) THEN
  RAISE EXCEPTION 'P0-01.3 follow-up: unreadable pages must fall back for current requests and are unnecessary for past requests';
 END IF;
END $unreadable$;
ALTER TABLE public.p0013_freshness_unreadable_pages RENAME TO job_pages;

-- Publish a ready page covering the new mark. The next client read sees it.
UPDATE public.job_pages jp
 SET covers_mark_version = m.mark_version, page = jsonb_set(jp.page, '{summary,phase}', '"complete"')
 FROM public.job_change_marks m
 WHERE jp.job_id = m.job_id AND jp.job_id = '00000104-0000-4000-8000-000000000002';
DO $retry$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.context_client_story('00000104-0000-4000-8000-000000000002')->'jobs') j
                WHERE j->>'job_number' = 'ZZTEST-1566-2' AND j->>'phase' = 'complete') THEN
  RAISE EXCEPTION 'P0-01.3 follow-up: a refreshed page must be usable on the next request';
 END IF;
END $retry$;

DO $plan$
DECLARE
 plan jsonb;
 scan_relations text[];
BEGIN
 EXECUTE $q$EXPLAIN (ANALYZE, FORMAT JSON)
  SELECT jp.page FROM public.job_pages jp
  WHERE jp.job_id = '00000104-0000-4000-8000-000000000002' AND jp.status = 'ready'
   AND NOT EXISTS (SELECT 1 FROM public.job_change_marks m
                    WHERE m.job_id = jp.job_id AND m.mark_version IS DISTINCT FROM jp.covers_mark_version)$q$ INTO plan;
 WITH RECURSIVE nodes(node) AS (
  SELECT plan #> '{0,Plan}'
  UNION ALL
  SELECT child FROM nodes CROSS JOIN LATERAL jsonb_array_elements(node->'Plans') child
 )
 SELECT array_agg(node->>'Relation Name' ORDER BY node->>'Relation Name')
 INTO scan_relations
 FROM nodes WHERE node->>'Node Type' IN ('Index Scan', 'Index Only Scan') AND node ? 'Index Cond'
  AND (node->>'Actual Rows')::int <= 2 AND (node->>'Actual Loops')::int = 1;
 IF plan::text LIKE '%Seq Scan%' OR scan_relations IS DISTINCT FROM
    ARRAY['job_change_mark_events', 'job_change_marks_base', 'job_pages', 'jobs']
    OR (plan #>> '{0,Plan,Actual Rows}')::int <> 1 THEN
  RAISE EXCEPTION 'P0-01.3 follow-up: freshness probe must use bounded index reads: %', plan;
 END IF;
END $plan$;

\ir ../../../rollbacks/20261118061243_context_client_story_stored_freshness_down.sql
DO $down$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_proc
                WHERE oid = 'public.context_client_story_stored(uuid,timestamptz)'::regprocedure
                  AND md5(prosrc) = '1500b7b747061ddce4c5a44ac16b6ff5') THEN
  RAISE EXCEPTION 'P0-01.3 follow-up: rollback did not restore the prior stored reader';
 END IF;
END $down$;
ROLLBACK;
\echo P0-01.3 freshness contract passed: inactive parity, stale/failed/missing pages, exact past answer, read failure, refresh retry, bounded index reads and rollback
