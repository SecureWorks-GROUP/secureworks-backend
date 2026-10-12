-- Contract: 20261011130000_context_record_scope. Every fixture write is rolled back. Job numbers, names
-- and words are synthetic; the first job is SWF-261469's shape (diagnosis cio-ctx-missing-info): an
-- accepted quote that sold 16 m (8.5 m at 1800 mm plus 7.5 m at 1200 mm, 7 panels) and a custom extra
-- "2 hours 2 trades For Jack hammering and cutting roots" at $240 ex GST, on a price record that also
-- holds the fencing and delivery lines. Everything is read as of a fixed instant over fixed dates.
--
--  1. Shape: both bodies keep definer, search path, volatility and grants; the timeline comment keeps its
--     slice names first.
--  2. SWF-261469: the sent and accepted lines carry the scope summary and the $240 extra (and only it);
--     the generated-folded and viewed lines and the amount are unchanged.
--  3. Whose extra: a document whose quote lines do not name the extra gets its scope and no extra; a
--     document with no quote lines gets the job's extras only as the one current client quote; two
--     current client quotes, a run document and a superseded one get no price.
--  4. Cut: a long scope and five extras stay within 360 characters, the extras whole and named
--     three plus "and 2 more", the scope cut with an ellipsis.
--  5. Odd records: a price record with no line list, string lines, an unpriced extra and a scope that is
--     not text never raise and add nothing.
--  6. The vision policy: a photo up to 10 MB; the PDF limit, page images, caps and ceiling unchanged.
--  7. Re-applying the migration changes nothing.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.rs_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'record scope contract: %', p_msg; END IF; END $$;
CREATE FUNCTION pg_temp.rs_job(p_id uuid, p_number text, p_pricing jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, client_email, ghl_contact_id, site_suburb, metadata, pricing_json,
  created_at)
 VALUES (p_id, '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', p_number, 'Pat Example', NULL, 'ghl-' || p_number,
  'Testville', '{}', p_pricing, '2026-09-20 01:00Z');
 RETURN p_id;
END $$;
CREATE FUNCTION pg_temp.rs_doc(p_id uuid, p_job uuid, p_number text, p_sent timestamptz, p_accepted timestamptz, p_pack jsonb,
 p_run text DEFAULT NULL, p_superseded timestamptz DEFAULT NULL, p_viewed timestamptz DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at, viewed_at, accepted_at, superseded_at,
  run_label, trade_pack_json)
 VALUES (p_id, p_job, 'quote', p_number, 1, p_sent - interval '5 minutes', p_sent, p_viewed, p_accepted, p_superseded, p_run, p_pack);
 RETURN p_id;
END $$;
-- The words of one document's line for one event, as of the fixed instant.
CREATE FUNCTION pg_temp.rs_what(p_job uuid, p_doc uuid, p_ev text) RETURNS text LANGUAGE sql AS $$
 SELECT t.what FROM public.context_job_record_timeline(ARRAY[p_job], '2026-10-11 05:00Z') t
 WHERE t.source_table = 'job_documents' AND t.source_id = p_doc::text AND t.kind = 'quote' AND t.what ~ (' ' || p_ev || '($|,|;)')
$$;

-- 1. Shape.
DO $shape$
DECLARE x record; p record;
BEGIN
 FOR x IN SELECT * FROM (VALUES ('public.context_job_record_timeline(uuid[],timestamptz)', true, 's', ARRAY['search_path=public, pg_temp']),
   ('public.context_document_vision_policy()', false, 'i', ARRAY['search_path=pg_catalog'])) v(sig, secdef, vol, cfg) LOOP
  SELECT pr.prosecdef, pr.provolatile, pr.proconfig INTO p FROM pg_proc pr WHERE pr.oid = to_regprocedure(x.sig);
  PERFORM pg_temp.rs_assert(p.prosecdef = x.secdef AND p.provolatile = x.vol AND p.proconfig = x.cfg, x.sig || ' flags changed');
  PERFORM pg_temp.rs_assert(has_function_privilege('service_role', x.sig, 'EXECUTE') AND NOT has_function_privilege('anon', x.sig, 'EXECUTE')
   AND NOT has_function_privilege('authenticated', x.sig, 'EXECUTE'), x.sig || ' grants changed');
 END LOOP;
 PERFORM pg_temp.rs_assert(obj_description('public.context_job_record_timeline(uuid[],timestamptz)'::regprocedure, 'pg_proc')
   LIKE 'Job record (20261006011000), story fixes (20261006033000), story safety (20261006040000): (record scope, 20261011130000) %',
  'the timeline comment must keep its slice names first');
END $shape$;

BEGIN;
-- 2. SWF-261469.
SELECT pg_temp.rs_job('7a000000-0000-4000-8000-000000000001', 'SWF-261469', $j$
{"line_items": [
  {"unit": "m", "category": "fencing", "quantity": 16, "cost_price": null, "sell_price": 125, "total_sell": 2000,
   "description": "7× Sameside (16.0m total)"},
  {"kind": "material", "unit": "job", "category": "custom", "quantity": 1, "cost_price": 160, "sell_price": 240, "total_sell": 240,
   "description": "2 hours 2 trades For Jack hammering and cutting roots "},
  {"unit": "lot", "category": "delivery", "quantity": 1, "cost_price": 95, "sell_price": 200, "total_sell": 200, "description": "Delivery"}],
 "totalIncGST": 2684}
$j$::jsonb);
SELECT pg_temp.rs_doc('7ad00000-0000-4000-8000-000000000001', '7a000000-0000-4000-8000-000000000001', 'Q-0797',
 '2026-09-24 03:20Z', '2026-09-24 03:21Z', $p$
{"summary": "RNR · Sameside · Monument · 8.5m LHS - Colorbond install 1800mm · 7.5m Front - Colorbond install 1200mm",
 "quote_lines": [{"unit": "m", "quantity": 8.5, "description": "Monument Sameside fencing — 8.5m"},
  {"unit": "lot", "quantity": 1, "description": "Delivery (pro-rated)"},
  {"unit": "m", "quantity": 7.5, "description": "Monument Sameside fencing — 7.5m"},
  {"unit": "m", "quantity": 16, "description": "7× Sameside (16.0m total)"},
  {"unit": "job", "quantity": 1, "description": "2 hours 2 trades For Jack hammering and cutting roots"}],
 "quote_notes": ["16m Colorbond Fencing — 1800mm Monument — Testville"]}
$p$::jsonb, NULL, NULL, '2026-09-24 03:20:30Z');
DO $c2$
DECLARE sent text := pg_temp.rs_what('7a000000-0000-4000-8000-000000000001', '7ad00000-0000-4000-8000-000000000001', 'sent');
 acc text := pg_temp.rs_what('7a000000-0000-4000-8000-000000000001', '7ad00000-0000-4000-8000-000000000001', 'accepted');
 viewed text := pg_temp.rs_what('7a000000-0000-4000-8000-000000000001', '7ad00000-0000-4000-8000-000000000001', 'viewed');
 sold text := '; scope: RNR · Sameside · Monument · 8.5m LHS - Colorbond install 1800mm · 7.5m Front - Colorbond install 1200mm'
  || '; extras: 2 hours 2 trades For Jack hammering and cutting roots $240.00 ex GST';
 n integer;
BEGIN
 PERFORM pg_temp.rs_assert(sent LIKE 'Quote Q-0797 v1 sent, value %' AND right(sent, length(sold)) = sold, 'SWF-261469 sent line: ' || coalesce(sent, '<none>'));
 PERFORM pg_temp.rs_assert(acc LIKE 'Quote Q-0797 v1 accepted%' AND right(acc, length(sold)) = sold, 'SWF-261469 accepted line: ' || coalesce(acc, '<none>'));
 PERFORM pg_temp.rs_assert(viewed = 'Quote Q-0797 v1 viewed', 'the viewed line is unchanged: ' || coalesce(viewed, '<none>'));
 PERFORM pg_temp.rs_assert(position('Delivery' IN sent) = 0 AND position('$2,000.00' IN sent) = 0 AND position('$160' IN sent) = 0,
  'only the custom extra is priced, at its sell price');
 -- one line per event: the generated event folds into sent, as before
 SELECT count(*) INTO n FROM public.context_job_record_timeline(ARRAY['7a000000-0000-4000-8000-000000000001'::uuid], '2026-10-11 05:00Z') t
 WHERE t.kind = 'quote';
 PERFORM pg_temp.rs_assert(n = 3, 'three quote lines (sent, viewed, accepted), got ' || n);
 -- before the quote went out nothing is read from it
 SELECT count(*) INTO n FROM public.context_job_record_timeline(ARRAY['7a000000-0000-4000-8000-000000000001'::uuid], '2026-09-24 03:00Z') t
 WHERE t.kind = 'quote';
 PERFORM pg_temp.rs_assert(n = 0, 'no quote line before the quote existed');
END $c2$;

-- 3. Whose extra.
-- (a) quote lines that do not name the extra: scope, no extra
SELECT pg_temp.rs_job('7a000000-0000-4000-8000-000000000002', 'SWF-900002',
 '{"line_items": [{"category": "custom", "quantity": 1, "sell_price": 90, "description": "Remove old gate"}]}');
SELECT pg_temp.rs_doc('7ad00000-0000-4000-8000-000000000002', '7a000000-0000-4000-8000-000000000002', 'Q-9002', '2026-09-25 01:00Z', NULL,
 '{"summary": "12m Colorbond 1800mm", "quote_lines": [{"description": "Colorbond fencing 12m"}]}');
-- (b) no quote lines, the one current client quote: the job's extras, priced quantity times sell price
SELECT pg_temp.rs_job('7a000000-0000-4000-8000-000000000003', 'SWF-900003',
 '{"line_items": [{"category": "custom", "quantity": 2, "sell_price": 55.5, "description": "Cut  back\n shrubs"},
   {"category": "fencing", "quantity": 10, "sell_price": 120, "total_sell": 1200, "description": "Fence"}]}');
SELECT pg_temp.rs_doc('7ad00000-0000-4000-8000-000000000003', '7a000000-0000-4000-8000-000000000003', 'Q-9003', '2026-09-25 01:00Z', NULL, NULL);
-- (c) two current client quotes with no quote lines: neither takes the extras
SELECT pg_temp.rs_job('7a000000-0000-4000-8000-000000000004', 'SWF-900004',
 '{"line_items": [{"category": "custom", "quantity": 1, "sell_price": 300, "description": "Retaining sleeper"}]}');
SELECT pg_temp.rs_doc('7ad00000-0000-4000-8000-000000000041', '7a000000-0000-4000-8000-000000000004', 'Q-9041', '2026-09-25 01:00Z', NULL, '{}');
SELECT pg_temp.rs_doc('7ad00000-0000-4000-8000-000000000042', '7a000000-0000-4000-8000-000000000004', 'Q-9042', '2026-09-26 01:00Z', NULL, '{}');
-- (d) a run document with no quote lines beside the client's superseded one: no price on either; the
-- superseded document's own quote lines name the extra but its price record is today's, so scope only
SELECT pg_temp.rs_job('7a000000-0000-4000-8000-000000000005', 'SWF-900005',
 '{"line_items": [{"category": "custom", "quantity": 1, "sell_price": 150, "description": "Post hole rock"}]}');
SELECT pg_temp.rs_doc('7ad00000-0000-4000-8000-000000000051', '7a000000-0000-4000-8000-000000000005', 'Q-9051', '2026-09-25 01:00Z', NULL,
 '{"summary": "First version", "quote_lines": [{"description": "Post hole rock"}]}', NULL, '2026-09-27 01:00Z');
SELECT pg_temp.rs_doc('7ad00000-0000-4000-8000-000000000052', '7a000000-0000-4000-8000-000000000005', 'Q-9052', '2026-09-27 01:00Z', NULL,
 '{}', 'RHS');
DO $c3$
DECLARE w text;
BEGIN
 w := pg_temp.rs_what('7a000000-0000-4000-8000-000000000002', '7ad00000-0000-4000-8000-000000000002', 'sent');
 PERFORM pg_temp.rs_assert(w LIKE 'Quote Q-9002 v1 sent, %; scope: 12m Colorbond 1800mm', 'unnamed extra: ' || coalesce(w, '<none>'));
 PERFORM pg_temp.rs_assert(position('extras' IN w) = 0, 'an extra the document does not name is not its: ' || w);
 w := pg_temp.rs_what('7a000000-0000-4000-8000-000000000003', '7ad00000-0000-4000-8000-000000000003', 'sent');
 PERFORM pg_temp.rs_assert(w LIKE 'Quote Q-9003 v1 sent, %; extras: Cut back shrubs $111.00 ex GST' AND position('scope' IN w) = 0,
  'the one current client quote takes the job''s extras: ' || coalesce(w, '<none>'));
 PERFORM pg_temp.rs_assert(position('$1,200.00' IN w) = 0, 'a fencing line is not an extra');
 PERFORM pg_temp.rs_assert(position('extras' IN pg_temp.rs_what('7a000000-0000-4000-8000-000000000004', '7ad00000-0000-4000-8000-000000000041', 'sent')) = 0
  AND position('extras' IN pg_temp.rs_what('7a000000-0000-4000-8000-000000000004', '7ad00000-0000-4000-8000-000000000042', 'sent')) = 0,
  'two current client quotes: neither takes the job''s extras');
 w := pg_temp.rs_what('7a000000-0000-4000-8000-000000000005', '7ad00000-0000-4000-8000-000000000051', 'sent');
 PERFORM pg_temp.rs_assert(w LIKE '%; scope: First version' AND position('$150' IN w) = 0, 'a superseded document has no price: ' || coalesce(w, '<none>'));
 -- read before it was superseded, the same document takes its own extra
 SELECT t.what INTO w FROM public.context_job_record_timeline(ARRAY['7a000000-0000-4000-8000-000000000005'::uuid], '2026-09-26 01:00Z') t
 WHERE t.source_id = '7ad00000-0000-4000-8000-000000000051' AND t.what LIKE '% sent%';
 PERFORM pg_temp.rs_assert(w LIKE '%; scope: First version; extras: Post hole rock $150.00 ex GST', 'before supersession: ' || coalesce(w, '<none>'));
 w := pg_temp.rs_what('7a000000-0000-4000-8000-000000000005', '7ad00000-0000-4000-8000-000000000052', 'sent');
 PERFORM pg_temp.rs_assert(w LIKE 'Quote Q-9052 v1 (RHS) sent, %' AND position('extras' IN w) = 0 AND position('scope' IN w) = 0,
  'a run document takes no job extras: ' || coalesce(w, '<none>'));
END $c3$;

-- 4. Cut.
SELECT pg_temp.rs_job('7a000000-0000-4000-8000-000000000006', 'SWF-900006', (SELECT jsonb_build_object('line_items', jsonb_agg(jsonb_build_object(
  'category', 'custom', 'quantity', 1, 'sell_price', 1000 + i,
  'description', CASE WHEN i = 1 THEN repeat('Long extra words ', 8) ELSE 'Extra ' || i END) ORDER BY i)) FROM generate_series(1, 5) i));
SELECT pg_temp.rs_doc('7ad00000-0000-4000-8000-000000000006', '7a000000-0000-4000-8000-000000000006', 'Q-9006', '2026-09-25 01:00Z', NULL, NULL);
UPDATE public.job_documents SET trade_pack_json = jsonb_build_object('summary', repeat('Colorbond run ', 40),
  'quote_lines', (SELECT jsonb_agg(jsonb_build_object('description', CASE WHEN i = 1 THEN repeat('Long extra words ', 8) ELSE 'Extra ' || i END))
                  FROM generate_series(1, 5) i))
WHERE id = '7ad00000-0000-4000-8000-000000000006';
DO $c4$
DECLARE w text := pg_temp.rs_what('7a000000-0000-4000-8000-000000000006', '7ad00000-0000-4000-8000-000000000006', 'sent');
BEGIN
 PERFORM pg_temp.rs_assert(length(w) <= 360, 'the line stays within 360 characters, got ' || length(w));
 PERFORM pg_temp.rs_assert(w LIKE '%; scope: Colorbond run Colorbond run%…; extras: %', 'the scope is cut with an ellipsis: ' || w);
 PERFORM pg_temp.rs_assert(w LIKE '%; extras: Long extra words Long extra words Long extra words Long ext… $1,001.00 ex GST, Extra 2 $1,002.00 ex GST, Extra 3 $1,003.00 ex GST, and 2 more',
  'three extras whole, each cut at 60, then the count: ' || w);
END $c4$;

-- 5. Odd records.
SELECT pg_temp.rs_job('7a000000-0000-4000-8000-000000000007', 'SWF-900007',
 '{"line_items": ["custom", 4, {"category": "custom", "description": "No price"}, {"category": "custom", "sell_price": "240", "description": "Text price"},
   {"category": "custom", "sell_price": 10, "description": "   "}]}');
SELECT pg_temp.rs_doc('7ad00000-0000-4000-8000-000000000007', '7a000000-0000-4000-8000-000000000007', 'Q-9007', '2026-09-25 01:00Z', NULL,
 '{"summary": {"text": "not text"}, "quote_lines": "not a list"}');
SELECT pg_temp.rs_job('7a000000-0000-4000-8000-000000000008', 'SWF-900008', '{"line_items": {"custom": 1}}');
SELECT pg_temp.rs_doc('7ad00000-0000-4000-8000-000000000008', '7a000000-0000-4000-8000-000000000008', 'Q-9008', '2026-09-25 01:00Z', NULL,
 '{"summary": "   "}');
SELECT pg_temp.rs_job('7a000000-0000-4000-8000-000000000009', 'SWF-900009', NULL);
SELECT pg_temp.rs_doc('7ad00000-0000-4000-8000-000000000009', '7a000000-0000-4000-8000-000000000009', 'Q-9009', '2026-09-25 01:00Z', NULL,
 '"a string pack"');
DO $c5$
DECLARE i integer; w text;
BEGIN
 FOR i IN 7..9 LOOP
  w := pg_temp.rs_what(('7a000000-0000-4000-8000-00000000000' || i)::uuid, ('7ad00000-0000-4000-8000-00000000000' || i)::uuid, 'sent');
  PERFORM pg_temp.rs_assert(w IS NOT NULL AND position('scope' IN w) = 0 AND position('extras' IN w) = 0, 'odd record ' || i || ': ' || coalesce(w, '<none>'));
 END LOOP;
END $c5$;
ROLLBACK;

-- 6. The vision policy.
DO $c6$
DECLARE p jsonb := public.context_document_vision_policy();
BEGIN
 PERFORM pg_temp.rs_assert((p ->> 'max_image_bytes')::bigint = 10000000, 'a photo up to 10 MB');
 PERFORM pg_temp.rs_assert((p ->> 'max_pdf_bytes')::bigint = 5000000 AND (p ->> 'max_images')::int = 5 AND (p ->> 'min_image_side')::int = 300
   AND (p ->> 'daily_cap_default')::int = 100 AND (p ->> 'daily_cap_max')::int = 300 AND (p ->> 'shared_calls_ceiling')::int = 500
   AND (p ->> 'batch_limit')::int = 5 AND (SELECT count(*) FROM jsonb_object_keys(p)) = 23,
  'everything else in the vision policy is unchanged');
END $c6$;

-- 7. Re-applying the migration changes nothing (its guard accepts its own bodies).
BEGIN;
CREATE TEMP TABLE record_scope_md5 AS
 SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS m, obj_description(p.oid, 'pg_proc') AS c FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('context_job_record_timeline', 'context_document_vision_policy');
\ir ../../../migrations/20261011130000_context_record_scope.sql
DO $again$
BEGIN
 IF (SELECT count(*) FROM record_scope_md5) <> 2 OR EXISTS (SELECT 1 FROM record_scope_md5 x JOIN pg_proc p ON p.oid = x.sig::regprocedure
       WHERE md5(p.prosrc) IS DISTINCT FROM x.m OR obj_description(p.oid, 'pg_proc') IS DISTINCT FROM x.c) THEN
  RAISE EXCEPTION 'record scope contract: a re-apply must change nothing';
 END IF;
END $again$;
ROLLBACK;
