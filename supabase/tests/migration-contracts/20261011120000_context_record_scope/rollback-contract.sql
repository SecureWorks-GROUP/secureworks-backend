-- Rollback contract: 20261011120000_context_record_scope. The runner applied the stack through this
-- migration and then its down. Both bodies and the timeline comment are the earlier ones word for word
-- (20261006040000's record timeline, 20261006060000's vision policy), flags and grants stand, the
-- earlier behaviour is back (a quote line ends at its value; a photo up to 5 MB); the down runs again
-- cleanly, and the migration re-applies on top of its own rollback.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.rb_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'record scope rollback contract: %', p_msg; END IF; END $$;
CREATE FUNCTION pg_temp.rb_restored() RETURNS void LANGUAGE plpgsql AS $$
DECLARE x record; p record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_job_record_timeline(uuid[],timestamptz)', '0921f25dfb5a67ab04629d2977e9f0a6', '9ac84b0dc9ac8294e3662200ee6b3432', 's', true),
  ('public.context_document_vision_policy()', '160abaf805bacd50e6ee570385c67037', NULL, 'i', false)
 ) v(sig, m, cm, vol, secdef) LOOP
  SELECT md5(pr.prosrc) AS m, md5(obj_description(pr.oid, 'pg_proc')) AS cm, pr.prosecdef, pr.provolatile INTO p
  FROM pg_proc pr WHERE pr.oid = to_regprocedure(x.sig);
  PERFORM pg_temp.rb_assert(p.m = x.m, x.sig || ' is not the earlier body');
  PERFORM pg_temp.rb_assert(p.cm IS NOT DISTINCT FROM x.cm, x.sig || ' comment is not the earlier one word for word');
  PERFORM pg_temp.rb_assert(p.prosecdef = x.secdef AND p.provolatile = x.vol, x.sig || ' flags changed');
  PERFORM pg_temp.rb_assert(has_function_privilege('service_role', x.sig, 'EXECUTE') AND NOT has_function_privilege('anon', x.sig, 'EXECUTE')
   AND NOT has_function_privilege('authenticated', x.sig, 'EXECUTE'), x.sig || ' grants changed');
 END LOOP;
END $$;

SELECT pg_temp.rb_restored();

-- The earlier behaviour: the accepted line ends at its value; a photo up to 5 MB.
BEGIN;
DO $c$
DECLARE w text;
BEGIN
 INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, client_email, ghl_contact_id, site_suburb, metadata, pricing_json, created_at)
 VALUES ('7b000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'SWF-261469', 'Pat Example', NULL,
  'ghl-SWF-261469', 'Testville', '{}',
  '{"line_items": [{"category": "custom", "quantity": 1, "sell_price": 240, "total_sell": 240, "description": "2 hours 2 trades For Jack hammering and cutting roots"}]}',
  '2026-09-20 01:00Z');
 INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at, accepted_at, trade_pack_json)
 VALUES ('7bd00000-0000-4000-8000-000000000001', '7b000000-0000-4000-8000-000000000001', 'quote', 'Q-0797', 1, '2026-09-24 03:15Z',
  '2026-09-24 03:20Z', '2026-09-24 03:21Z',
  '{"summary": "16m Sameside", "quote_lines": [{"description": "2 hours 2 trades For Jack hammering and cutting roots"}]}');
 SELECT t.what INTO w FROM public.context_job_record_timeline(ARRAY['7b000000-0000-4000-8000-000000000001'::uuid], '2026-10-11 05:00Z') t
 WHERE t.source_id = '7bd00000-0000-4000-8000-000000000001' AND t.what LIKE '% accepted%';
 PERFORM pg_temp.rb_assert(w LIKE 'Quote Q-0797 v1 accepted%' AND position('scope' IN w) = 0 AND position('$240' IN w) = 0,
  'the earlier accepted line: ' || coalesce(w, '<none>'));
 PERFORM pg_temp.rb_assert((public.context_document_vision_policy() ->> 'max_image_bytes')::bigint = 5000000, 'a photo up to 5 MB again');
END $c$;
ROLLBACK;

-- The down runs again cleanly (its guard accepts the earlier bodies), and changes nothing.
\ir ../../../rollbacks/20261011120000_context_record_scope_down.sql
SELECT pg_temp.rb_restored();

-- The migration re-applies on top of its own rollback.
BEGIN;
\ir ../../../migrations/20261011120000_context_record_scope.sql
DO $re$
BEGIN
 PERFORM pg_temp.rb_assert((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_job_record_timeline(uuid[],timestamptz)'::regprocedure)
  = '27df48d65b222613575ed617470866e7', 'the migration did not re-apply its timeline');
 PERFORM pg_temp.rb_assert((public.context_document_vision_policy() ->> 'max_image_bytes')::bigint = 10000000, 'the migration did not re-apply its policy');
END $re$;
ROLLBACK;
