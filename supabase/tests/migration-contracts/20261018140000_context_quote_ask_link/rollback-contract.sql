-- Rollback contract: 20261018140000_context_quote_ask_link. The runner applied the stack through
-- this migration and then its down. The timeline body and comment are the record-scope ones
-- (20261011130000). The vision policy is untouched. A sent quote line no longer says what it is
-- for. The down runs again cleanly, and the migration re-applies on top of its own rollback.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.qal_rb_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'quote ask link rollback contract: %', p_msg; END IF; END $$;

CREATE FUNCTION pg_temp.qal_rb_restored() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p record; c text;
BEGIN
 SELECT md5(pr.prosrc) AS m, pr.prosecdef, pr.provolatile, pr.proconfig INTO p
 FROM pg_proc pr WHERE pr.oid = to_regprocedure('public.context_job_record_timeline(uuid[],timestamptz)');
 c := obj_description('public.context_job_record_timeline(uuid[],timestamptz)'::regprocedure, 'pg_proc');
 PERFORM pg_temp.qal_rb_assert(p.m = 'fca5eda750a40bbf1f2d8f0e7cf33055', 'timeline is not the record-scope body');
 PERFORM pg_temp.qal_rb_assert(c LIKE '%(record scope, 20261011130000)%' AND c NOT LIKE '%quote ask link%',
  'timeline comment is not the record-scope comment');
 PERFORM pg_temp.qal_rb_assert(p.prosecdef AND p.provolatile = 's' AND p.proconfig = ARRAY['search_path=public, pg_temp'],
  'timeline flags changed');
 PERFORM pg_temp.qal_rb_assert(has_function_privilege('service_role', 'public.context_job_record_timeline(uuid[],timestamptz)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.context_job_record_timeline(uuid[],timestamptz)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.context_job_record_timeline(uuid[],timestamptz)', 'EXECUTE'),
  'timeline grants changed');
 PERFORM pg_temp.qal_rb_assert((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_document_vision_policy()'::regprocedure)
   = 'e2fc43a4e4d7189daac5c894423ac5dc', 'the vision policy moved');
END $$;

SELECT pg_temp.qal_rb_restored();

-- The earlier behaviour: a sent line with a named section does not say what the quote is for.
BEGIN;
DO $c$
DECLARE w text;
BEGIN
 INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, client_email, ghl_contact_id, site_suburb, metadata, pricing_json, created_at)
 VALUES ('8b000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'quoted', 'fencing', 'SWF-QAL-RB', 'Pat Example', NULL,
  'ghl-SWF-QAL-RB', 'Testville', '{}', NULL, '2026-09-20 01:00Z');
 INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at)
 VALUES ('8bd00000-0000-4000-8000-000000000001', '8b000000-0000-4000-8000-000000000001', 'quote', 'Q-0798', 1,
  '2026-09-30 01:00Z', '2026-10-01 01:00Z');
 INSERT INTO public.quote_revisions (id, job_id, job_document_id, version, totals_snapshot_json, released_via, sent_at, pricing_snapshot_json)
 VALUES ('8be00000-0000-4000-8000-000000000001', '8b000000-0000-4000-8000-000000000001', '8bd00000-0000-4000-8000-000000000001',
  1, '{}'::jsonb, 'contract', NULL, '{"raw":{"runs":[{"run_name":"Rear"}]}}');
 SELECT t.what INTO w FROM public.context_job_record_timeline(ARRAY['8b000000-0000-4000-8000-000000000001'::uuid], '2026-10-18 05:00Z') t
 WHERE t.source_id = '8bd00000-0000-4000-8000-000000000001' AND t.what ~ ' sent($|,|;)';
 PERFORM pg_temp.qal_rb_assert(w = 'Quote Q-0798 v1 sent, value not recorded (not recorded on the sent quote)'
  AND position('; for:' IN w) = 0 AND position('Rear' IN w) = 0, 'the earlier sent line: ' || coalesce(w, '<none>'));
END $c$;
ROLLBACK;

-- The down runs again cleanly, and changes nothing.
\ir ../../../rollbacks/20261018140000_context_quote_ask_link_down.sql
SELECT pg_temp.qal_rb_restored();

-- The migration re-applies on top of its own rollback, and the sent line then names the section.
BEGIN;
\ir ../../../migrations/20261018140000_context_quote_ask_link.sql
DO $re$
DECLARE w text;
BEGIN
 PERFORM pg_temp.qal_rb_assert((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_job_record_timeline(uuid[],timestamptz)'::regprocedure)
   = '97d773b91b6789b0e54f8cc2c809cd48', 'the migration did not re-apply its timeline');
 PERFORM pg_temp.qal_rb_assert(obj_description('public.context_job_record_timeline(uuid[],timestamptz)'::regprocedure, 'pg_proc')
   LIKE '%(quote ask link, 20261018140000)%', 'the migration did not re-apply its comment');
 PERFORM pg_temp.qal_rb_assert((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_document_vision_policy()'::regprocedure)
   = 'e2fc43a4e4d7189daac5c894423ac5dc', 'the re-apply moved the vision policy');
 INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, client_email, ghl_contact_id, site_suburb, metadata, pricing_json, created_at)
 VALUES ('8c000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'quoted', 'fencing', 'SWF-QAL-RE', 'Pat Example', NULL,
  'ghl-SWF-QAL-RE', 'Testville', '{}', NULL, '2026-09-20 01:00Z');
 INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at)
 VALUES ('8cd00000-0000-4000-8000-000000000001', '8c000000-0000-4000-8000-000000000001', 'quote', 'Q-0799', 1,
  '2026-09-30 01:00Z', '2026-10-01 01:00Z');
 INSERT INTO public.quote_revisions (id, job_id, job_document_id, version, totals_snapshot_json, released_via, sent_at, pricing_snapshot_json)
 VALUES ('8ce00000-0000-4000-8000-000000000001', '8c000000-0000-4000-8000-000000000001', '8cd00000-0000-4000-8000-000000000001',
  1, '{}'::jsonb, 'contract', NULL, '{"raw":{"runs":[{"run_name":"Rear"}]}}');
 SELECT t.what INTO w FROM public.context_job_record_timeline(ARRAY['8c000000-0000-4000-8000-000000000001'::uuid], '2026-10-18 05:00Z') t
 WHERE t.source_id = '8cd00000-0000-4000-8000-000000000001' AND t.what ~ ' sent($|,|;)';
 PERFORM pg_temp.qal_rb_assert(w = 'Quote Q-0799 v1 sent, value not recorded (not recorded on the sent quote); for: Rear',
  'the re-applied sent line: ' || coalesce(w, '<none>'));
END $re$;
ROLLBACK;

SELECT pg_temp.qal_rb_restored();
