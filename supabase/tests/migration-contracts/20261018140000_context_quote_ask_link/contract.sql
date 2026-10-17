-- Contract: 20261018140000_context_quote_ask_link. Every fixture write is rolled back.
-- Names and quote numbers are synthetic. The fixed instant is 2026-10-18 05:00Z.
--
-- A sent or accepted quote line gains "; for: <what this quote is for>" before "; scope:".
-- The words come from that quote's own data, first source that has any: the document
-- snapshot's own run, else the newest revision's run names (that snapshot is the whole
-- job's price record, so a document with a run_label keeps only the runs that label
-- names), else that revision's job description, else up to three of its line descriptions with no price, else the job's
-- run names only when this document is the one current client quote. A blank name and
-- a name that is only "run" or "runs" is skipped. Viewed, declined, generated and the
-- superseded event gain nothing. A neighbour name or address is never copied.
--
-- The reader keeps a slug word of four or more letters and drops the family words
-- fence and patio. "rear" matches quote:rear-fence. "blade" and "screen" match
-- quote:blade-screen. Each line below carries its own words and not its sibling's.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.qal_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'quote ask link contract: %', p_msg; END IF; END $$;

CREATE FUNCTION pg_temp.qal_job(p_id uuid, p_number text, p_pricing jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, client_email, ghl_contact_id, site_suburb, metadata, pricing_json, created_at)
 VALUES (p_id, '00000000-0000-4000-8000-000000000001', 'quoted', 'fencing', p_number, 'Pat Example', NULL, 'ghl-' || p_number,
  'Testville', '{}', p_pricing, '2026-09-20 01:00Z');
 RETURN p_id;
END $$;

CREATE FUNCTION pg_temp.qal_doc(p_id uuid, p_job uuid, p_number text, p_sent timestamptz,
 p_accepted timestamptz DEFAULT NULL, p_viewed timestamptz DEFAULT NULL, p_declined timestamptz DEFAULT NULL,
 p_superseded timestamptz DEFAULT NULL, p_run text DEFAULT NULL, p_pack jsonb DEFAULT NULL, p_snap jsonb DEFAULT NULL)
 RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at, viewed_at, accepted_at, declined_at,
  superseded_at, run_label, trade_pack_json, data_snapshot_json)
 VALUES (p_id, p_job, 'quote', p_number, 1, p_sent - interval '1 day', p_sent, p_viewed, p_accepted, p_declined,
  p_superseded, p_run, p_pack, p_snap);
 RETURN p_id;
END $$;

CREATE FUNCTION pg_temp.qal_rev(p_id uuid, p_job uuid, p_doc uuid, p_version int, p_snap jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO public.quote_revisions (id, job_id, job_document_id, version, totals_snapshot_json, released_via, sent_at, pricing_snapshot_json)
 VALUES (p_id, p_job, p_doc, p_version, '{}'::jsonb, 'contract', NULL, p_snap);
 RETURN p_id;
END $$;

CREATE FUNCTION pg_temp.qal_what(p_job uuid, p_doc uuid, p_ev text) RETURNS text LANGUAGE sql AS $$
 SELECT t.what FROM public.context_job_record_timeline(ARRAY[p_job], '2026-10-18 05:00Z') t
 WHERE t.source_table = 'job_documents' AND t.source_id = p_doc::text AND t.kind = 'quote'
   AND t.what ~ (' ' || p_ev || '($|,|;)')
$$;

CREATE FUNCTION pg_temp.qal_for(p_what text) RETURNS text LANGUAGE sql AS $$
 SELECT substring(p_what FROM '; for: ([^;]*)')
$$;

-- 1. Shape. The timeline body is this migration's. The vision policy is the record-scope one.
DO $shape$
DECLARE p record;
BEGIN
 SELECT pr.prosecdef, pr.provolatile, pr.proconfig, md5(pr.prosrc) AS m INTO p
 FROM pg_proc pr WHERE pr.oid = to_regprocedure('public.context_job_record_timeline(uuid[],timestamptz)');
 PERFORM pg_temp.qal_assert(p.m = '0bee62495835e22f6ac80393e3a58fbb', 'timeline md5 ' || coalesce(p.m, '<missing>'));
 PERFORM pg_temp.qal_assert(p.prosecdef AND p.provolatile = 's' AND p.proconfig = ARRAY['search_path=public, pg_temp'],
  'timeline flags changed');
 PERFORM pg_temp.qal_assert(has_function_privilege('service_role', 'public.context_job_record_timeline(uuid[],timestamptz)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.context_job_record_timeline(uuid[],timestamptz)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.context_job_record_timeline(uuid[],timestamptz)', 'EXECUTE'),
  'timeline grants changed');
 PERFORM pg_temp.qal_assert(obj_description('public.context_job_record_timeline(uuid[],timestamptz)'::regprocedure, 'pg_proc')
   LIKE 'Job record (20261006011000), story fixes (20261006033000), story safety (20261006040000): (record scope, 20261011130000) %'
   AND obj_description('public.context_job_record_timeline(uuid[],timestamptz)'::regprocedure, 'pg_proc')
   LIKE '%(quote ask link, 20261018140000)%',
  'the timeline comment must keep its slice names first and name this slice');
 PERFORM pg_temp.qal_assert((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_document_vision_policy()'::regprocedure)
   = 'e2fc43a4e4d7189daac5c894423ac5dc', 'the vision policy moved');
END $shape$;

BEGIN;
-- Two quotes on one job. The job's own run name is "Today only" and must not be used.
-- The rear revision also carries a neighbour name and address, and a run label that loses to run_name.
SELECT pg_temp.qal_job('8a000000-0000-4000-8000-000000000001', 'SWF-QAL-01', '{"runs":[{"name":"Today only"}]}');
SELECT pg_temp.qal_doc('8ad00000-0000-4000-8000-000000000011', '8a000000-0000-4000-8000-000000000001', 'Q-1101',
 '2026-10-01 01:00Z', '2026-10-02 01:00Z');
SELECT pg_temp.qal_rev('8ae00000-0000-4000-8000-000000000011', '8a000000-0000-4000-8000-000000000001',
 '8ad00000-0000-4000-8000-000000000011', 1,
 '{"raw":{"runs":[{"run_name":"Rear","run_label":"Side Gate","neighbour_name":"Pat Neighbour","neighbour_address":"9 Harbour Road"},{"run_name":"RUN"},{"run_name":"runs"}]}}');
SELECT pg_temp.qal_doc('8ad00000-0000-4000-8000-000000000012', '8a000000-0000-4000-8000-000000000001', 'Q-1102',
 '2026-10-01 01:00Z');
SELECT pg_temp.qal_rev('8ae00000-0000-4000-8000-000000000012', '8a000000-0000-4000-8000-000000000001',
 '8ad00000-0000-4000-8000-000000000012', 2,
 '{"raw":{"runs":[{"run_name":"Blade screen"}]}}');

-- Highest version wins. An empty newer revision does not fall through to the older one's name.
SELECT pg_temp.qal_job('8a000000-0000-4000-8000-000000000002', 'SWF-QAL-02', NULL);
SELECT pg_temp.qal_doc('8ad00000-0000-4000-8000-000000000021', '8a000000-0000-4000-8000-000000000002', 'Q-1201',
 '2026-10-01 01:00Z');
SELECT pg_temp.qal_rev('8ae00000-0000-4000-8000-000000000021', '8a000000-0000-4000-8000-000000000002',
 '8ad00000-0000-4000-8000-000000000021', 1, '{"raw":{"runs":[{"run_name":"Old patio"}]}}');
SELECT pg_temp.qal_rev('8ae00000-0000-4000-8000-000000000022', '8a000000-0000-4000-8000-000000000002',
 '8ad00000-0000-4000-8000-000000000021', 2, '{"raw":{"runs":[{"run_name":"Rear"}]}}');

SELECT pg_temp.qal_job('8a000000-0000-4000-8000-000000000003', 'SWF-QAL-03', NULL);
SELECT pg_temp.qal_doc('8ad00000-0000-4000-8000-000000000031', '8a000000-0000-4000-8000-000000000003', 'Q-2201',
 '2026-10-01 01:00Z');
SELECT pg_temp.qal_rev('8ae00000-0000-4000-8000-000000000031', '8a000000-0000-4000-8000-000000000003',
 '8ad00000-0000-4000-8000-000000000031', 1, '{"raw":{"runs":[{"run_name":"Rear"}]}}');
SELECT pg_temp.qal_rev('8ae00000-0000-4000-8000-000000000032', '8a000000-0000-4000-8000-000000000003',
 '8ad00000-0000-4000-8000-000000000031', 2, '{}');

-- Distinct names keep the earliest. RUN and runs are skipped.
SELECT pg_temp.qal_job('8a000000-0000-4000-8000-000000000004', 'SWF-QAL-04', NULL);
SELECT pg_temp.qal_doc('8ad00000-0000-4000-8000-000000000041', '8a000000-0000-4000-8000-000000000004', 'Q-2301',
 '2026-10-01 01:00Z');
SELECT pg_temp.qal_rev('8ae00000-0000-4000-8000-000000000041', '8a000000-0000-4000-8000-000000000004',
 '8ad00000-0000-4000-8000-000000000041', 1,
 '{"raw":{"runs":[{"run_name":"Front"},{"run_name":"Rear"},{"run_name":"Front"},{"run_name":"RUN"},{"run_label":"runs"}]}}');

-- A revision with no names falls through to the document snapshot. RUN falls through to its run label.
SELECT pg_temp.qal_job('8a000000-0000-4000-8000-000000000005', 'SWF-QAL-05', NULL);
SELECT pg_temp.qal_doc('8ad00000-0000-4000-8000-000000000051', '8a000000-0000-4000-8000-000000000005', 'Q-1301',
 '2026-10-01 01:00Z', NULL, NULL, NULL, NULL, NULL, NULL,
 '{"run":{"run_name":"RUN","run_label":"Side Return","neighbour_name":"Pat Neighbour"}}');
SELECT pg_temp.qal_rev('8ae00000-0000-4000-8000-000000000051', '8a000000-0000-4000-8000-000000000005',
 '8ad00000-0000-4000-8000-000000000051', 1, '{}');

-- Job description, whitespace collapsed, only when the revision has no run names.
SELECT pg_temp.qal_job('8a000000-0000-4000-8000-000000000006', 'SWF-QAL-06', NULL);
SELECT pg_temp.qal_doc('8ad00000-0000-4000-8000-000000000061', '8a000000-0000-4000-8000-000000000006', 'Q-1401',
 '2026-10-01 01:00Z');
SELECT pg_temp.qal_rev('8ae00000-0000-4000-8000-000000000061', '8a000000-0000-4000-8000-000000000006',
 '8ad00000-0000-4000-8000-000000000061', 1, '{"raw":{"job_description":"  Colourbond   return  "}}');

-- Up to three line descriptions. A blank, a non-object and the fourth are dropped. No price is attached.
SELECT pg_temp.qal_job('8a000000-0000-4000-8000-000000000007', 'SWF-QAL-07', NULL);
SELECT pg_temp.qal_doc('8ad00000-0000-4000-8000-000000000071', '8a000000-0000-4000-8000-000000000007', 'Q-1501',
 '2026-10-01 01:00Z');
SELECT pg_temp.qal_rev('8ae00000-0000-4000-8000-000000000071', '8a000000-0000-4000-8000-000000000007',
 '8ad00000-0000-4000-8000-000000000071', 1,
 jsonb_build_object('raw', jsonb_build_object('line_items', jsonb_build_array(
   to_jsonb('Rear'::text),
   jsonb_build_object('description', '   '),
   jsonb_build_object('description', repeat('Panel ', 12) || 'ZZTAIL', 'total_sell', 160),
   jsonb_build_object('description', 'Gate return'),
   jsonb_build_object('description', 'Post cap'),
   jsonb_build_object('description', 'Fourth sleeper')))));

-- The job's run names, only for the one current client quote. RUN and runs are skipped.
SELECT pg_temp.qal_job('8a000000-0000-4000-8000-000000000008', 'SWF-QAL-08',
 '{"runs":[{"name":"RUN"},{"name":"runs"},{"name":"Rear"}]}');
SELECT pg_temp.qal_doc('8ad00000-0000-4000-8000-000000000081', '8a000000-0000-4000-8000-000000000008', 'Q-1601',
 '2026-10-01 01:00Z');
SELECT pg_temp.qal_rev('8ae00000-0000-4000-8000-000000000081', '8a000000-0000-4000-8000-000000000008',
 '8ad00000-0000-4000-8000-000000000081', 1, '{}');

-- Two current client quotes share the job's runs and neither may use them.
SELECT pg_temp.qal_job('8a000000-0000-4000-8000-000000000009', 'SWF-QAL-09',
 '{"runs":[{"name":"Rear"}]}');
SELECT pg_temp.qal_doc('8ad00000-0000-4000-8000-000000000091', '8a000000-0000-4000-8000-000000000009', 'Q-1701',
 '2026-10-01 01:00Z');
SELECT pg_temp.qal_doc('8ad00000-0000-4000-8000-000000000092', '8a000000-0000-4000-8000-000000000009', 'Q-1702',
 '2026-10-01 01:00Z');
SELECT pg_temp.qal_rev('8ae00000-0000-4000-8000-000000000091', '8a000000-0000-4000-8000-000000000009',
 '8ad00000-0000-4000-8000-000000000091', 1, '{}');
SELECT pg_temp.qal_rev('8ae00000-0000-4000-8000-000000000092', '8a000000-0000-4000-8000-000000000009',
 '8ad00000-0000-4000-8000-000000000092', 2, '{}');

-- A superseded document still says what it was for, from its own revision, and not today's job runs.
-- Its superseded event says nothing about what it was for. Its scope stays and its price does not.
SELECT pg_temp.qal_job('8a000000-0000-4000-8000-00000000000a', 'SWF-QAL-10',
 jsonb_build_object('runs', jsonb_build_array(jsonb_build_object('name', 'Today only')),
  'line_items', jsonb_build_array(jsonb_build_object('category', 'custom', 'description', 'Short extra', 'total_sell', 10))));
SELECT pg_temp.qal_doc('8ad00000-0000-4000-8000-0000000000a1', '8a000000-0000-4000-8000-00000000000a', 'Q-1801',
 '2026-10-01 01:00Z', NULL, NULL, NULL, '2026-10-03 01:00Z', NULL, '{"summary":"Short scope"}');
SELECT pg_temp.qal_rev('8ae00000-0000-4000-8000-0000000000a1', '8a000000-0000-4000-8000-00000000000a',
 '8ad00000-0000-4000-8000-0000000000a1', 1, '{"raw":{"runs":[{"run_name":"Front"}]}}');

-- Viewed and generated gain nothing. The sent line of the same document does.
SELECT pg_temp.qal_job('8a000000-0000-4000-8000-00000000000b', 'SWF-QAL-11', NULL);
SELECT pg_temp.qal_doc('8ad00000-0000-4000-8000-0000000000b1', '8a000000-0000-4000-8000-00000000000b', 'Q-1901',
 '2026-10-01 01:00Z', NULL, '2026-10-01 02:00Z');
SELECT pg_temp.qal_rev('8ae00000-0000-4000-8000-0000000000b1', '8a000000-0000-4000-8000-00000000000b',
 '8ad00000-0000-4000-8000-0000000000b1', 1, '{"raw":{"runs":[{"run_name":"Rear"}]}}');

-- The run_label column is the line's party mark, not what the quote is for, even when the job names a section.
SELECT pg_temp.qal_job('8a000000-0000-4000-8000-00000000000c', 'SWF-QAL-12', '{"runs":[{"name":"Rear"}]}');
SELECT pg_temp.qal_doc('8ad00000-0000-4000-8000-0000000000c1', '8a000000-0000-4000-8000-00000000000c', 'Q-2001',
 '2026-10-01 01:00Z', NULL, NULL, NULL, NULL, 'RHS');

-- A long section name and a long scope stay within 360 characters. The extras stay whole.
-- The job's run name must not replace the revision's.
SELECT pg_temp.qal_job('8a000000-0000-4000-8000-00000000000d', 'SWF-QAL-13',
 jsonb_build_object(
  'line_items', jsonb_build_array(jsonb_build_object('category', 'custom', 'description', 'Short extra', 'total_sell', 10, 'quantity', 1)),
  'runs', jsonb_build_array(jsonb_build_object('name', 'Today only'))));
SELECT pg_temp.qal_doc('8ad00000-0000-4000-8000-0000000000d1', '8a000000-0000-4000-8000-00000000000d', 'Q-3600',
 '2026-10-01 01:00Z', NULL, NULL, NULL, NULL, NULL, jsonb_build_object('summary', repeat('Colorbond panel ', 20)));
SELECT pg_temp.qal_rev('8ae00000-0000-4000-8000-0000000000d1', '8a000000-0000-4000-8000-00000000000d',
 '8ad00000-0000-4000-8000-0000000000d1', 1,
 jsonb_build_object('raw', jsonb_build_object('runs', jsonb_build_array(jsonb_build_object('run_name', repeat('Rear ', 30))))));

-- Send-runs shape: one revision, on the first run document only, lists every run on the job.
-- Each run document carries its own run, and each line names only that run.
SELECT pg_temp.qal_job('8a000000-0000-4000-8000-00000000000f', 'SWF-QAL-15', '{"runs":[{"name":"Rear"},{"name":"Front"}]}');
SELECT pg_temp.qal_doc('8ad00000-0000-4000-8000-0000000000f1', '8a000000-0000-4000-8000-00000000000f', 'Q-2401',
 '2026-10-01 01:00Z', NULL, NULL, NULL, NULL, 'Rear', NULL, '{"run":{"run_name":"Rear"}}');
SELECT pg_temp.qal_doc('8ad00000-0000-4000-8000-0000000000f2', '8a000000-0000-4000-8000-00000000000f', 'Q-2402',
 '2026-10-01 01:00Z', NULL, NULL, NULL, NULL, 'Front', NULL, '{"run":{"run_name":"Front"}}');
SELECT pg_temp.qal_rev('8ae00000-0000-4000-8000-0000000000f1', '8a000000-0000-4000-8000-00000000000f',
 '8ad00000-0000-4000-8000-0000000000f1', 1, '{"raw":{"runs":[{"run_name":"Rear","run_label":"Rear"},{"run_name":"Front","run_label":"Front"}]}}');

-- A run document with no snapshot run keeps only the revision run its run_label names.
SELECT pg_temp.qal_job('8a000000-0000-4000-8000-000000000010', 'SWF-QAL-16', NULL);
SELECT pg_temp.qal_doc('8ad00000-0000-4000-8000-000000000101', '8a000000-0000-4000-8000-000000000010', 'Q-2501',
 '2026-10-01 01:00Z', NULL, NULL, NULL, NULL, 'Front');
SELECT pg_temp.qal_rev('8ae00000-0000-4000-8000-000000000101', '8a000000-0000-4000-8000-000000000010',
 '8ad00000-0000-4000-8000-000000000101', 1, '{"raw":{"runs":[{"run_name":"Rear","run_label":"Rear"},{"run_name":"Front","run_label":"Front"}]}}');

-- A document's own run named only by name wins over its revision's job-wide runs.
SELECT pg_temp.qal_job('8a000000-0000-4000-8000-000000000011', 'SWF-QAL-17', NULL);
SELECT pg_temp.qal_doc('8ad00000-0000-4000-8000-000000000111', '8a000000-0000-4000-8000-000000000011', 'Q-2601',
 '2026-10-01 01:00Z', NULL, NULL, NULL, NULL, NULL, NULL, '{"run":{"name":"Side Return"}}');
SELECT pg_temp.qal_rev('8ae00000-0000-4000-8000-000000000111', '8a000000-0000-4000-8000-000000000011',
 '8ad00000-0000-4000-8000-000000000111', 1, '{"raw":{"runs":[{"run_name":"Rear"},{"run_name":"Front"}]}}');

-- Odd records do not raise and add no words. A declined line gains nothing.
SELECT pg_temp.qal_job('8a000000-0000-4000-8000-00000000000e', 'SWF-QAL-14', '{"runs":{"name":"Rear"},"line_items":{"custom":1}}');
SELECT pg_temp.qal_doc('8ad00000-0000-4000-8000-0000000000e1', '8a000000-0000-4000-8000-00000000000e', 'Q-2101',
 '2026-10-01 01:00Z', NULL, NULL, '2026-10-02 01:00Z', NULL, NULL, NULL, '{"run":"Rear"}');
SELECT pg_temp.qal_rev('8ae00000-0000-4000-8000-0000000000e1', '8a000000-0000-4000-8000-00000000000e',
 '8ad00000-0000-4000-8000-0000000000e1', 1,
 '{"raw":{"runs":{"run_name":"Rear"},"line_items":{"description":"Rear"},"job_description":12}}');

DO $cases$
DECLARE
 rear text; blade text; accepted text; highest text; ignored text; ordered text; side text; descr text; items text;
 sole text; one text; two text; old_sent text; old_event text; viewed text; generated text; rhs text; cut text;
 odd text; declined text; phrase text; n int; amt numeric; run_rear text; run_front text; labelled text; own_name text;
BEGIN
 rear := pg_temp.qal_what('8a000000-0000-4000-8000-000000000001', '8ad00000-0000-4000-8000-000000000011', 'sent');
 blade := pg_temp.qal_what('8a000000-0000-4000-8000-000000000001', '8ad00000-0000-4000-8000-000000000012', 'sent');
 accepted := pg_temp.qal_what('8a000000-0000-4000-8000-000000000001', '8ad00000-0000-4000-8000-000000000011', 'accepted');
 PERFORM pg_temp.qal_assert(rear = 'Quote Q-1101 v1 sent, value not recorded (not recorded on the sent quote); for: Rear',
  'rear sent line: ' || coalesce(rear, '<none>'));
 PERFORM pg_temp.qal_assert(blade = 'Quote Q-1102 v1 sent, value not recorded (not recorded on the sent quote); for: Blade screen',
  'blade sent line: ' || coalesce(blade, '<none>'));
 PERFORM pg_temp.qal_assert(accepted = 'Quote Q-1101 v1 accepted; for: Rear', 'rear accepted line: ' || coalesce(accepted, '<none>'));
 PERFORM pg_temp.qal_assert(rear ~* '\mrear\M' AND rear !~* '\mblade\M' AND rear !~* '\mscreen\M'
  AND blade ~* '\mblade\M' AND blade ~* '\mscreen\M' AND blade !~* '\mrear\M',
  'each line must match its own slug and not its sibling');
 PERFORM pg_temp.qal_assert(position('Today only' IN rear) = 0 AND position('Today only' IN blade) = 0
  AND position('Side Gate' IN rear) = 0 AND position('Pat Neighbour' IN rear) = 0 AND position('Harbour' IN rear) = 0
  AND position('RUN' IN rear) = 0, 'the rear line copied a word that is not its section: ' || rear);
 PERFORM pg_temp.qal_assert(pg_temp.qal_what('8a000000-0000-4000-8000-000000000001', '8ad00000-0000-4000-8000-000000000011', 'generated')
   = 'Quote Q-1101 v1 generated', 'a generated line gained words');

 highest := pg_temp.qal_what('8a000000-0000-4000-8000-000000000002', '8ad00000-0000-4000-8000-000000000021', 'sent');
 PERFORM pg_temp.qal_assert(pg_temp.qal_for(highest) = 'Rear' AND position('Old patio' IN highest) = 0,
  'highest version: ' || coalesce(highest, '<none>'));
 ignored := pg_temp.qal_what('8a000000-0000-4000-8000-000000000003', '8ad00000-0000-4000-8000-000000000031', 'sent');
 PERFORM pg_temp.qal_assert(ignored = 'Quote Q-2201 v1 sent, value not recorded (not recorded on the sent quote)'
  AND position('Rear' IN ignored) = 0, 'an empty newer revision fell through: ' || coalesce(ignored, '<none>'));

 ordered := pg_temp.qal_what('8a000000-0000-4000-8000-000000000004', '8ad00000-0000-4000-8000-000000000041', 'sent');
 PERFORM pg_temp.qal_assert(pg_temp.qal_for(ordered) = 'Front, Rear', 'name order: ' || coalesce(pg_temp.qal_for(ordered), '<none>'));

 side := pg_temp.qal_what('8a000000-0000-4000-8000-000000000005', '8ad00000-0000-4000-8000-000000000051', 'sent');
 PERFORM pg_temp.qal_assert(pg_temp.qal_for(side) = 'Side Return' AND position('Pat Neighbour' IN side) = 0,
  'snapshot run: ' || coalesce(side, '<none>'));

 descr := pg_temp.qal_what('8a000000-0000-4000-8000-000000000006', '8ad00000-0000-4000-8000-000000000061', 'sent');
 PERFORM pg_temp.qal_assert(pg_temp.qal_for(descr) = 'Colourbond return', 'job description: ' || coalesce(pg_temp.qal_for(descr), '<none>'));

 items := pg_temp.qal_what('8a000000-0000-4000-8000-000000000007', '8ad00000-0000-4000-8000-000000000071', 'sent');
 phrase := left(repeat('Panel ', 12) || 'ZZTAIL', 49) || '…, Gate return, Post cap';
 PERFORM pg_temp.qal_assert(pg_temp.qal_for(items) = phrase, 'line descriptions: ' || coalesce(pg_temp.qal_for(items), '<none>'));
 PERFORM pg_temp.qal_assert(position('ZZTAIL' IN items) = 0 AND position('Fourth' IN items) = 0 AND position('Rear' IN items) = 0
  AND position('$' IN pg_temp.qal_for(items)) = 0 AND position('160' IN items) = 0,
  'a line description kept a price or a dropped item: ' || coalesce(items, '<none>'));

 sole := pg_temp.qal_what('8a000000-0000-4000-8000-000000000008', '8ad00000-0000-4000-8000-000000000081', 'sent');
 PERFORM pg_temp.qal_assert(pg_temp.qal_for(sole) = 'Rear', 'sole current quote: ' || coalesce(pg_temp.qal_for(sole), '<none>'));
 one := pg_temp.qal_what('8a000000-0000-4000-8000-000000000009', '8ad00000-0000-4000-8000-000000000091', 'sent');
 two := pg_temp.qal_what('8a000000-0000-4000-8000-000000000009', '8ad00000-0000-4000-8000-000000000092', 'sent');
 PERFORM pg_temp.qal_assert(position('; for:' IN one) = 0 AND position('Rear' IN one) = 0
  AND position('; for:' IN two) = 0 AND position('Rear' IN two) = 0,
  'a second current quote used the job runs: ' || coalesce(one, '<none>') || ' / ' || coalesce(two, '<none>'));

 old_sent := pg_temp.qal_what('8a000000-0000-4000-8000-00000000000a', '8ad00000-0000-4000-8000-0000000000a1', 'sent');
 old_event := pg_temp.qal_what('8a000000-0000-4000-8000-00000000000a', '8ad00000-0000-4000-8000-0000000000a1', 'superseded');
 PERFORM pg_temp.qal_assert(old_sent = 'Quote Q-1801 v1 sent, value not recorded (not recorded on the sent quote); for: Front; scope: Short scope',
  'superseded sent line: ' || coalesce(old_sent, '<none>'));
 PERFORM pg_temp.qal_assert(position('Today only' IN old_sent) = 0 AND position('$' IN old_sent) = 0 AND position('extras' IN old_sent) = 0
  AND position('; for:' IN old_sent) < position('; scope:' IN old_sent),
  'superseded sent line took today''s price or runs: ' || old_sent);
 PERFORM pg_temp.qal_assert(old_event = 'Quote Q-1801 v1 superseded', 'superseded event: ' || coalesce(old_event, '<none>'));

 viewed := pg_temp.qal_what('8a000000-0000-4000-8000-00000000000b', '8ad00000-0000-4000-8000-0000000000b1', 'viewed');
 generated := pg_temp.qal_what('8a000000-0000-4000-8000-00000000000b', '8ad00000-0000-4000-8000-0000000000b1', 'generated');
 PERFORM pg_temp.qal_assert(viewed = 'Quote Q-1901 v1 viewed', 'viewed line: ' || coalesce(viewed, '<none>'));
 PERFORM pg_temp.qal_assert(generated = 'Quote Q-1901 v1 generated', 'generated line: ' || coalesce(generated, '<none>'));
 PERFORM pg_temp.qal_assert(pg_temp.qal_for(pg_temp.qal_what('8a000000-0000-4000-8000-00000000000b', '8ad00000-0000-4000-8000-0000000000b1', 'sent')) = 'Rear',
  'the sent line of a viewed quote lost its section');

 rhs := pg_temp.qal_what('8a000000-0000-4000-8000-00000000000c', '8ad00000-0000-4000-8000-0000000000c1', 'sent');
 PERFORM pg_temp.qal_assert(rhs LIKE 'Quote Q-2001 v1 (RHS) sent, %' AND position('; for:' IN rhs) = 0 AND position('Rear' IN rhs) = 0,
  'a run label became what the quote is for: ' || coalesce(rhs, '<none>'));

 cut := pg_temp.qal_what('8a000000-0000-4000-8000-00000000000d', '8ad00000-0000-4000-8000-0000000000d1', 'sent');
 PERFORM pg_temp.qal_assert(cut IS NOT NULL AND length(cut) <= 360, 'cut length: ' || coalesce(length(cut)::text, '<none>'));
 PERFORM pg_temp.qal_assert(pg_temp.qal_for(cut) = left(repeat('Rear ', 30), 79) || '…', 'cut section: ' || coalesce(pg_temp.qal_for(cut), '<none>'));
 PERFORM pg_temp.qal_assert(position('; for:' IN cut) < position('; scope:' IN cut)
  AND position('; scope:' IN cut) < position('; extras:' IN cut)
  AND cut LIKE '%…; extras: Short extra $10.00 ex GST'
  AND position('Today only' IN cut) = 0, 'cut order: ' || coalesce(cut, '<none>'));

 run_rear := pg_temp.qal_what('8a000000-0000-4000-8000-00000000000f', '8ad00000-0000-4000-8000-0000000000f1', 'sent');
 run_front := pg_temp.qal_what('8a000000-0000-4000-8000-00000000000f', '8ad00000-0000-4000-8000-0000000000f2', 'sent');
 PERFORM pg_temp.qal_assert(run_rear LIKE 'Quote Q-2401 v1 (Rear) sent, %' AND pg_temp.qal_for(run_rear) = 'Rear'
  AND position('Front' IN run_rear) = 0, 'send-runs rear line: ' || coalesce(run_rear, '<none>'));
 PERFORM pg_temp.qal_assert(run_front LIKE 'Quote Q-2402 v1 (Front) sent, %' AND pg_temp.qal_for(run_front) = 'Front'
  AND position('Rear' IN run_front) = 0, 'send-runs front line: ' || coalesce(run_front, '<none>'));
 labelled := pg_temp.qal_what('8a000000-0000-4000-8000-000000000010', '8ad00000-0000-4000-8000-000000000101', 'sent');
 PERFORM pg_temp.qal_assert(pg_temp.qal_for(labelled) = 'Front' AND position('Rear' IN labelled) = 0,
  'run label filter: ' || coalesce(labelled, '<none>'));
 own_name := pg_temp.qal_what('8a000000-0000-4000-8000-000000000011', '8ad00000-0000-4000-8000-000000000111', 'sent');
 PERFORM pg_temp.qal_assert(pg_temp.qal_for(own_name) = 'Side Return' AND position('Rear' IN own_name) = 0
  AND position('Front' IN own_name) = 0, 'own run name: ' || coalesce(own_name, '<none>'));

 odd := pg_temp.qal_what('8a000000-0000-4000-8000-00000000000e', '8ad00000-0000-4000-8000-0000000000e1', 'sent');
 declined := pg_temp.qal_what('8a000000-0000-4000-8000-00000000000e', '8ad00000-0000-4000-8000-0000000000e1', 'declined');
 PERFORM pg_temp.qal_assert(odd = 'Quote Q-2101 v1 sent, value not recorded (not recorded on the sent quote)' AND position('Rear' IN odd) = 0,
  'odd records added words: ' || coalesce(odd, '<none>'));
 PERFORM pg_temp.qal_assert(declined = 'Quote Q-2101 v1 declined', 'declined line: ' || coalesce(declined, '<none>'));

 SELECT count(*) INTO n FROM public.context_job_record_timeline(ARRAY[
   '8a000000-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-000000000002', '8a000000-0000-4000-8000-000000000003',
   '8a000000-0000-4000-8000-000000000004', '8a000000-0000-4000-8000-000000000005', '8a000000-0000-4000-8000-000000000006',
   '8a000000-0000-4000-8000-000000000007', '8a000000-0000-4000-8000-000000000008', '8a000000-0000-4000-8000-000000000009',
   '8a000000-0000-4000-8000-00000000000a', '8a000000-0000-4000-8000-00000000000b', '8a000000-0000-4000-8000-00000000000c',
   '8a000000-0000-4000-8000-00000000000d', '8a000000-0000-4000-8000-00000000000e', '8a000000-0000-4000-8000-00000000000f',
   '8a000000-0000-4000-8000-000000000010', '8a000000-0000-4000-8000-000000000011']::uuid[], '2026-10-18 05:00Z') t
 WHERE t.kind = 'quote' AND t.what ~ '[—–]';
 PERFORM pg_temp.qal_assert(n = 0, 'a quote line contains an em dash');
 SELECT t.amount INTO amt FROM public.context_job_record_timeline(ARRAY['8a000000-0000-4000-8000-000000000001'::uuid], '2026-10-18 05:00Z') t
 WHERE t.source_id = '8ad00000-0000-4000-8000-000000000011' AND t.what ~ ' sent($|,|;)';
 PERFORM pg_temp.qal_assert(amt IS NULL, 'amount changed on a quote with no recorded value');
END $cases$;
ROLLBACK;

-- 2. Re-applying the migration changes nothing.
BEGIN;
CREATE TEMP TABLE qal_live AS
 SELECT md5(p.prosrc) AS m, obj_description(p.oid, 'pg_proc') AS c
 FROM pg_proc p WHERE p.oid = 'public.context_job_record_timeline(uuid[],timestamptz)'::regprocedure;
\ir ../../../migrations/20261018140000_context_quote_ask_link.sql
DO $again$
BEGIN
 IF EXISTS (SELECT 1 FROM qal_live x, pg_proc p
            WHERE p.oid = 'public.context_job_record_timeline(uuid[],timestamptz)'::regprocedure
              AND (md5(p.prosrc) IS DISTINCT FROM x.m OR obj_description(p.oid, 'pg_proc') IS DISTINCT FROM x.c)) THEN
  RAISE EXCEPTION 'quote ask link contract: a re-apply must change nothing';
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_document_vision_policy()'::regprocedure)
    IS DISTINCT FROM 'e2fc43a4e4d7189daac5c894423ac5dc' THEN
  RAISE EXCEPTION 'quote ask link contract: a re-apply moved the vision policy';
 END IF;
END $again$;
ROLLBACK;
