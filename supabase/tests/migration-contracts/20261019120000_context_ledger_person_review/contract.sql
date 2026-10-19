-- Contract for 20261019120000_context_ledger_person_review.
-- A person review (claimed_closed_unverified) is stored on insert and on a transition that does
-- not change status. An unattached ledger loop that carries one is a person review, and its
-- customer_waiting and money are clear, so the open-loop wait score leaves it out. A money
-- record loop clears money only when every open item attached to it carries a review. An open
-- request with no review still counts, and a genuine money loop with no reviewed attachment
-- still leads. Item status is not changed. Every fixture write is rolled back. Invented names only.

CREATE FUNCTION pg_temp.pr_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'person review contract: %', p_msg; END IF; END $$;

CREATE FUNCTION pg_temp.pr_job() RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, client_email, ghl_contact_id, site_suburb, metadata, created_at)
 VALUES ('8f000000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'scheduled', 'fencing', 'SWF-980101',
  'Robin Twojobs', 'robin.twojobs@example.test', 'pr-ct-robin', 'Testville', '{}', '2026-09-01 00:00Z');
 RETURN '8f000000-0000-4000-8000-0000000000a1';
END $$;

CREATE FUNCTION pg_temp.pr_ev() RETURNS uuid LANGUAGE plpgsql SET session_replication_role = replica AS $$
BEGIN
 INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, provider_message_id, payload, metadata,
  occurred_at, event_at, recorded_at, context_captured_at, attribution_status, attribution_step, attribution_confidence, attributed_at, match_method)
 VALUES ('8fb00000-0000-4000-8000-000000000001', '8f000000-0000-4000-8000-0000000000a1', 'client.sms_in', 'ledger_contract', 'sms', 'inbound',
  'pr-ct-robin', 'ghl:pr-01', jsonb_build_object('body', 'Can you confirm the gate width please'),
  jsonb_build_object('written_as', 'service_role', 'party_roles', jsonb_build_object('version', 'party_roles_v4',
    'basis', 'job_customer', 'counterpart_role', 'customer', 'audience', 'customer', 'sender_role', 'customer', 'recipient_role', 'staff')),
  '2026-10-05 01:00Z', '2026-10-05 01:00Z', '2026-10-05 01:00Z', '2026-10-05 01:00Z', 'direct', 1, 1, '2026-10-05 01:00Z', 'direct_job_id');
 RETURN '8fb00000-0000-4000-8000-000000000001';
END $$;

CREATE FUNCTION pg_temp.pr_cite() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_array(jsonb_build_object('table', 'business_events', 'id', '8fb00000-0000-4000-8000-000000000001',
  'excerpt', 'confirm the gate width')) $$;

CREATE FUNCTION pg_temp.pr_item(p_ref text, p_what text, p_extra jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('ref', p_ref, 'item_type', 'request', 'status', 'open', 'from_role', 'customer', 'to_role', 'us',
  'what', p_what, 'opened_by', pg_temp.pr_cite()) || p_extra $$;

CREATE FUNCTION pg_temp.pr_check(p_item jsonb) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.context_ledger_check_item('8f000000-0000-4000-8000-0000000000a1', p_item, 'model') $$;

-- 1. The column is there. This is the break proof's first failure.
DO $c$
BEGIN
 PERFORM pg_temp.pr_assert(EXISTS (
   SELECT 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'context_ledger_items'
     AND column_name = 'person_review' AND data_type = 'jsonb' AND is_nullable = 'YES'),
  'context_ledger_items.person_review stores the review');
END $c$;

-- 2. Shape: the normaliser, the four replaced comments, and the check.
DO $c$
DECLARE f text; c text; vol "char"; sec boolean;
BEGIN
 PERFORM pg_temp.pr_assert(to_regprocedure('public.context_ledger_person_review(jsonb,timestamptz)') IS NOT NULL, 'the normaliser exists');
 SELECT p.provolatile, p.prosecdef INTO vol, sec FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.context_ledger_person_review(jsonb,timestamptz)');
 PERFORM pg_temp.pr_assert(vol = 's' AND sec IS TRUE
  AND (SELECT p.proconfig = ARRAY['search_path=public, pg_temp'] FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.context_ledger_person_review(jsonb,timestamptz)')),
  'the normaliser is stable, security definer, search_path public, pg_temp');
 PERFORM pg_temp.pr_assert(has_function_privilege('service_role', 'public.context_ledger_person_review(jsonb,timestamptz)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.context_ledger_person_review(jsonb,timestamptz)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.context_ledger_person_review(jsonb,timestamptz)', 'EXECUTE'),
  'the normaliser is service_role only');
 PERFORM pg_temp.pr_assert(obj_description('public.context_ledger_person_review(jsonb,timestamptz)'::regprocedure, 'pg_proc')
  LIKE '%(person review, 20261018120000)%', 'the normaliser names this migration');
 PERFORM pg_temp.pr_assert(to_regprocedure('public.context_ledger_person_review_ok(jsonb)') IS NOT NULL, 'the stored-shape check exists');
 SELECT p.provolatile, p.prosecdef INTO vol, sec FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.context_ledger_person_review_ok(jsonb)');
 PERFORM pg_temp.pr_assert(vol = 's' AND sec IS TRUE
  AND (SELECT p.proconfig = ARRAY['search_path=public, pg_temp'] FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.context_ledger_person_review_ok(jsonb)')),
  'the stored-shape check is stable, security definer, search_path public, pg_temp');
 PERFORM pg_temp.pr_assert(has_function_privilege('service_role', 'public.context_ledger_person_review_ok(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.context_ledger_person_review_ok(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.context_ledger_person_review_ok(jsonb)', 'EXECUTE'),
  'the stored-shape check is service_role only');
 PERFORM pg_temp.pr_assert(obj_description('public.context_ledger_person_review_ok(jsonb)'::regprocedure, 'pg_proc')
  LIKE '%(person review, 20261018120000)%', 'the stored-shape check names this migration');
 FOREACH f IN ARRAY ARRAY[
  'public.context_ledger_check_item(uuid,jsonb,text,uuid,text)',
  'public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)',
  'public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)',
  'public.context_job_story_ledger(uuid,uuid,timestamptz)'] LOOP
  c := obj_description(to_regprocedure(f), 'pg_proc');
  PERFORM pg_temp.pr_assert(c LIKE '%(person review, 20261018120000)%', f || ' comment marker');
 END LOOP;
 c := obj_description('public.context_ledger_check_item(uuid,jsonb,text,uuid,text)'::regprocedure, 'pg_proc');
 PERFORM pg_temp.pr_assert(c LIKE 'Context ledger store (20261006013000), ledger reader fixes (20261007150000):%'
  AND c NOT LIKE 'Held notes%' AND c LIKE '% Held notes (20261015100000): %', 'item check keeps its earlier comment');
 c := obj_description('public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)'::regprocedure, 'pg_proc');
 PERFORM pg_temp.pr_assert(c LIKE 'Context ledger store (20261006013000), ledger reader fixes (20261007150000):%',
  'the write keeps its earlier comment');
 c := obj_description('public.context_job_story_ledger(uuid,uuid,timestamptz)'::regprocedure, 'pg_proc');
 PERFORM pg_temp.pr_assert(c NOT LIKE 'Held notes%' AND c LIKE '% Held notes (20261015100000): %', 'the story ledger keeps the held-notes marker');
 c := obj_description('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)'::regprocedure, 'pg_proc');
 PERFORM pg_temp.pr_assert(c LIKE '%(story settled notes, 20261011120000) (person review, 20261018120000)%'
  AND c LIKE '%(story lead rank, 20261011100000)%', 'the assembler keeps the settled-notes and lead-rank markers');
 PERFORM pg_temp.pr_assert(EXISTS (SELECT 1 FROM pg_constraint
  WHERE conname = 'context_ledger_items_person_review_check' AND conrelid = 'public.context_ledger_items'::regclass),
  'the stored-shape check exists');
END $c$;

-- 3. Behaviour. Old writers that omit the field match a JSON null. A sentence is stored as the object.
-- A same-status transition sets or clears a review and does not touch status. An open request with
-- no review stays a ledger loop; one that carries a review is a person review.
BEGIN;
SELECT pg_temp.pr_job();
SELECT pg_temp.pr_ev();
UPDATE public.automation_switches SET capture = true, attribution = true, extraction = true, all_stop = false WHERE id = 1;
UPDATE public.context_ledger_settings SET mode = 'shadow', calls_per_day = 50, reader = 'luna-ledger:v1', job_ids = NULL;

DO $c$
DECLARE
 job uuid := '8f000000-0000-4000-8000-0000000000a1';
 omit jsonb; nulled jsonb; sent jsonb; bad jsonb;
 cl jsonb; res jsonb; gen uuid; run uuid; tok uuid;
 k_omit text; k_sent text; k_null text;
 it public.context_ledger_items;
 n_tr integer; review jsonb; closed_at timestamptz;
 led jsonb; note jsonb;
 asm jsonb; plain jsonb; reviewed jsonb;
BEGIN
 -- item check: omit and JSON null are the same object, and neither carries the key
 omit := pg_temp.pr_check(pg_temp.pr_item('width', 'Robin asked us to confirm the gate width.'));
 nulled := pg_temp.pr_check(pg_temp.pr_item('width', 'Robin asked us to confirm the gate width.', '{"person_review":null}'));
 PERFORM pg_temp.pr_assert((omit ->> 'ok')::boolean AND omit -> 'item' = nulled -> 'item'
  AND NOT (omit -> 'item') ? 'person_review' AND NOT (nulled -> 'item') ? 'person_review',
  'omit and JSON null add no person_review key: ' || omit::text);
 sent := pg_temp.pr_check(pg_temp.pr_item('colour', 'Robin asked us to confirm the gate colour.',
  '{"person_review":"The notes say the colour was confirmed."}'));
 PERFORM pg_temp.pr_assert((sent ->> 'ok')::boolean
  AND ((sent -> 'item') - 'person_review'::text) = (pg_temp.pr_check(pg_temp.pr_item('colour', 'Robin asked us to confirm the gate colour.')) -> 'item')
  AND sent #>> '{item,person_review,sentence}' = 'The notes say the colour was confirmed.'
  AND sent #>> '{item,person_review,reason}' = 'claimed_closed_unverified'
  AND sent #> '{item,person_review,source_line_id}' = 'null'::jsonb
  AND sent #>> '{item,person_review,raised_at}' IS NOT NULL,
  'a sentence becomes the review object and changes nothing else: ' || sent::text);
 bad := pg_temp.pr_check(pg_temp.pr_item('width', 'Robin asked us to confirm the gate width.', '{"surprise":1}'));
 PERFORM pg_temp.pr_assert(NOT (bad ->> 'ok')::boolean AND bad ->> 'code' = 'invalid_shape' AND bad ->> 'detail' = 'unknown field surprise',
  'an unknown field is still refused: ' || bad::text);
 bad := pg_temp.pr_check(pg_temp.pr_item('width', 'Robin asked us to confirm the gate width.', '{"person_review":{"sentence":"x","reason":"made_up"}}'));
 PERFORM pg_temp.pr_assert(NOT (bad ->> 'ok')::boolean AND bad ->> 'detail' = 'person_review reason is claimed_closed_unverified',
  'a review reason other than claimed_closed_unverified is refused: ' || bad::text);
 bad := pg_temp.pr_check(pg_temp.pr_item('width', 'Robin asked us to confirm the gate width.', '{"person_review":1}'));
 PERFORM pg_temp.pr_assert(NOT (bad ->> 'ok')::boolean AND bad ->> 'detail' = 'person_review is a sentence, an object, or null',
  'a review that is not a sentence, an object or null is refused: ' || bad::text);

 -- insert: omit and JSON null store null; a sentence stores the object
 cl := public.context_ledger_claim(job, 'backfill', (now() AT TIME ZONE 'Australia/Perth')::date);
 PERFORM pg_temp.pr_assert(cl ->> 'outcome' = 'claimed', 'the job is claimed: ' || cl::text);
 run := (cl ->> 'run_id')::uuid; tok := (cl ->> 'lease_token')::uuid; gen := (cl ->> 'generation_id')::uuid;
 res := public.context_ledger_write(run, tok, gen, jsonb_build_array(
  pg_temp.pr_item('width', 'Robin asked us to confirm the gate width.'),
  pg_temp.pr_item('colour', 'Robin asked us to confirm the gate colour.', '{"person_review":"The notes say the colour was confirmed."}'),
  pg_temp.pr_item('height', 'Robin asked us to confirm the gate height.', '{"person_review":null}')), '[]', 'luna-ledger:v1');
 PERFORM pg_temp.pr_assert(jsonb_array_length(res -> 'accepted') = 3 AND res -> 'refused' = '[]'::jsonb,
  'three open requests are stored: ' || res::text);
 k_omit := (SELECT x ->> 'item_key' FROM jsonb_array_elements(res -> 'accepted') x WHERE x ->> 'ref' = 'width');
 k_sent := (SELECT x ->> 'item_key' FROM jsonb_array_elements(res -> 'accepted') x WHERE x ->> 'ref' = 'colour');
 k_null := (SELECT x ->> 'item_key' FROM jsonb_array_elements(res -> 'accepted') x WHERE x ->> 'ref' = 'height');
 SELECT * INTO it FROM public.context_ledger_items i WHERE i.generation_id = gen AND i.item_key = k_omit;
 PERFORM pg_temp.pr_assert(it.status = 'open' AND it.person_review IS NULL AND it.closed_at IS NULL, 'an omitted review stores null');
 SELECT * INTO it FROM public.context_ledger_items i WHERE i.generation_id = gen AND i.item_key = k_null;
 PERFORM pg_temp.pr_assert(it.person_review IS NULL, 'JSON null on insert stores null');
 SELECT * INTO it FROM public.context_ledger_items i WHERE i.generation_id = gen AND i.item_key = k_sent;
 PERFORM pg_temp.pr_assert(it.person_review ->> 'sentence' = 'The notes say the colour was confirmed.'
  AND it.person_review ->> 'reason' = 'claimed_closed_unverified'
  AND it.person_review -> 'source_line_id' = 'null'::jsonb
  AND it.person_review ->> 'raised_at' IS NOT NULL, 'a sentence on insert is the review object: ' || it.person_review::text);

 -- while still open: an unknown transition key, a bad review, and a close with no evidence change nothing
 res := public.context_ledger_write(run, tok, gen, '[]', jsonb_build_array(jsonb_build_object(
  'item_key', k_omit, 'to_status', 'open', 'evidence', '[]'::jsonb, 'surprise', 1)), 'luna-ledger:v1');
 PERFORM pg_temp.pr_assert((res ->> 'transitions_accepted')::int = 0
  AND res -> 'transitions_refused' -> 0 ->> 'detail' = 'a transition is {item_key, to_status, evidence, reason}',
  'an unknown transition key is refused as before: ' || res::text);
 res := public.context_ledger_write(run, tok, gen, '[]', jsonb_build_array(jsonb_build_object(
  'item_key', k_omit, 'to_status', 'open', 'person_review', 1)), 'luna-ledger:v1');
 PERFORM pg_temp.pr_assert(res -> 'transitions_refused' -> 0 ->> 'code' = 'invalid_shape'
  AND res -> 'transitions_refused' -> 0 ->> 'detail' = 'person_review is a sentence, an object, or null',
  'a transition review that is a number is refused: ' || res::text);
 res := public.context_ledger_write(run, tok, gen, '[]', jsonb_build_array(jsonb_build_object(
  'item_key', k_omit, 'to_status', 'closed', 'evidence', '[]'::jsonb)), 'luna-ledger:v1');
 PERFORM pg_temp.pr_assert(res -> 'transitions_refused' -> 0 ->> 'code' = 'evidence_missing'
  AND res -> 'transitions_refused' -> 0 ->> 'detail' = 'closed needs evidence',
  'a close with no evidence is still refused: ' || res::text);
 SELECT * INTO it FROM public.context_ledger_items i WHERE i.generation_id = gen AND i.item_key = k_omit;
 PERFORM pg_temp.pr_assert(it.status = 'open' AND it.person_review IS NULL AND it.closed_at IS NULL,
  'a refused transition leaves the open item alone');

 -- same status, with a sentence: the review is set, status stays open, and no evidence is required
 res := public.context_ledger_write(run, tok, gen, '[]', jsonb_build_array(jsonb_build_object(
  'item_key', k_omit, 'to_status', 'open', 'person_review', 'The notes say the width was confirmed.', 'reason', 'set review')),
  'luna-ledger:v1');
 PERFORM pg_temp.pr_assert((res ->> 'transitions_accepted')::int = 1 AND res -> 'transitions_refused' = '[]'::jsonb,
  'a same-status review is accepted: ' || res::text);
 SELECT * INTO it FROM public.context_ledger_items i WHERE i.generation_id = gen AND i.item_key = k_omit;
 PERFORM pg_temp.pr_assert(it.status = 'open' AND it.closed_at IS NULL
  AND it.person_review ->> 'sentence' = 'The notes say the width was confirmed.'
  AND it.person_review ->> 'reason' = 'claimed_closed_unverified',
  'the open item gains the review and stays open: ' || to_jsonb(it)::text);
 PERFORM pg_temp.pr_assert(EXISTS (SELECT 1 FROM public.context_ledger_transitions t
  WHERE t.item_id = it.id AND t.from_status = 'open' AND t.to_status = 'open' AND t.evidence IS NULL AND t.reason = 'set review'),
  'the review transition records no evidence');

 -- same status, key absent: still no change, and the review stays
 res := public.context_ledger_write(run, tok, gen, '[]', jsonb_build_array(jsonb_build_object(
  'item_key', k_omit, 'to_status', 'open', 'evidence', '[]'::jsonb)), 'luna-ledger:v1');
 PERFORM pg_temp.pr_assert(res -> 'transitions_refused' -> 0 ->> 'code' = 'no_change',
  'a same-status transition with no review is still no change: ' || res::text);
 SELECT person_review INTO review FROM public.context_ledger_items WHERE generation_id = gen AND item_key = k_omit;
 PERFORM pg_temp.pr_assert(review ->> 'sentence' = 'The notes say the width was confirmed.', 'no_change leaves the review');

 -- same status, JSON null: the review is cleared
 res := public.context_ledger_write(run, tok, gen, '[]', jsonb_build_array(jsonb_build_object(
  'item_key', k_omit, 'to_status', 'open', 'person_review', 'null'::jsonb, 'reason', 'clear review')), 'luna-ledger:v1');
 PERFORM pg_temp.pr_assert((res ->> 'transitions_accepted')::int = 1, 'a same-status null clears the review: ' || res::text);
 SELECT * INTO it FROM public.context_ledger_items i WHERE i.generation_id = gen AND i.item_key = k_omit;
 PERFORM pg_temp.pr_assert(it.status = 'open' AND it.person_review IS NULL, 'the review is cleared and the item stays open');

 -- same status, JSON null when the review is already null: no change, and no new transition
 SELECT count(*) INTO n_tr FROM public.context_ledger_transitions t
  JOIN public.context_ledger_items i ON i.id = t.item_id
  WHERE i.generation_id = gen AND i.item_key = k_omit;
 res := public.context_ledger_write(run, tok, gen, '[]', jsonb_build_array(jsonb_build_object(
  'item_key', k_omit, 'to_status', 'open', 'person_review', 'null'::jsonb, 'reason', 'clear again')), 'luna-ledger:v1');
 PERFORM pg_temp.pr_assert(res -> 'transitions_refused' -> 0 ->> 'code' = 'no_change'
  AND coalesce((res ->> 'transitions_accepted')::int, 0) = 0,
  'clearing a review that is already null is no change: ' || res::text);
 SELECT * INTO it FROM public.context_ledger_items i WHERE i.generation_id = gen AND i.item_key = k_omit;
 PERFORM pg_temp.pr_assert(it.status = 'open' AND it.person_review IS NULL
  AND (SELECT count(*) FROM public.context_ledger_transitions t WHERE t.item_id = it.id) = n_tr,
  'a null clear of an already-null review writes no transition');

 -- a stored object with a field the normaliser does not keep is refused by the column check
 BEGIN
  UPDATE public.context_ledger_items SET person_review = jsonb_build_object(
   'sentence', 'The notes say the width was confirmed.', 'source_line_id', NULL,
   'reason', 'claimed_closed_unverified', 'raised_at', '2026-10-10T01:00:00Z', 'note', 'extra')
   WHERE generation_id = gen AND item_key = k_omit;
  PERFORM pg_temp.pr_assert(false, 'an extra review key was stored');
 EXCEPTION WHEN check_violation THEN
  NULL;
 END;

 -- an empty object, a missing raised_at and a non-timestamp are not a stored review
 BEGIN
  UPDATE public.context_ledger_items SET person_review = '{}'::jsonb
   WHERE generation_id = gen AND item_key = k_omit;
  PERFORM pg_temp.pr_assert(false, 'an empty review object was stored');
 EXCEPTION WHEN check_violation THEN
  NULL;
 END;
 BEGIN
  UPDATE public.context_ledger_items SET person_review = jsonb_build_object(
   'sentence', 'The notes say the width was confirmed.', 'reason', 'claimed_closed_unverified')
   WHERE generation_id = gen AND item_key = k_omit;
  PERFORM pg_temp.pr_assert(false, 'a review with no raised_at was stored');
 EXCEPTION WHEN check_violation THEN
  NULL;
 END;
 BEGIN
  UPDATE public.context_ledger_items SET person_review = jsonb_build_object(
   'sentence', 'The notes say the width was confirmed.', 'reason', 'claimed_closed_unverified',
   'raised_at', 'not-a-timestamp')
   WHERE generation_id = gen AND item_key = k_omit;
  PERFORM pg_temp.pr_assert(false, 'a review with a non-timestamp raised_at was stored');
 EXCEPTION WHEN check_violation THEN
  NULL;
 END;

 -- same status, a structured object: sentence, source line and raised_at are kept
 res := public.context_ledger_write(run, tok, gen, '[]', jsonb_build_array(jsonb_build_object(
  'item_key', k_omit, 'to_status', 'open', 'reason', 'object review',
  'person_review', jsonb_build_object('sentence', 'The notes say the width was confirmed.',
   'source_line_id', 'line-7', 'raised_at', '2026-10-10T01:00:00Z'))), 'luna-ledger:v1');
 PERFORM pg_temp.pr_assert((res ->> 'transitions_accepted')::int = 1, 'a structured review is accepted: ' || res::text);
 SELECT * INTO it FROM public.context_ledger_items i WHERE i.generation_id = gen AND i.item_key = k_omit;
 PERFORM pg_temp.pr_assert(it.person_review = jsonb_build_object('sentence', 'The notes say the width was confirmed.',
   'source_line_id', 'line-7', 'reason', 'claimed_closed_unverified', 'raised_at', '2026-10-10T01:00:00Z'::timestamptz),
  'the stored review keeps the source line and the raised time: ' || it.person_review::text);
 led := public.context_job_story_ledger(job, gen, now());
 note := (SELECT x FROM jsonb_array_elements(led -> 'items') x WHERE x ->> 'item_key' = k_omit);
 PERFORM pg_temp.pr_assert(note -> 'person_review' = it.person_review, 'the story ledger shows the review: ' || note::text);
 note := (SELECT x FROM jsonb_array_elements(led -> 'items') x WHERE x ->> 'item_key' = k_null);
 PERFORM pg_temp.pr_assert(NOT note ? 'person_review', 'a null review adds no key on the story ledger: ' || note::text);

 -- a status change still needs evidence, and a review it does not name stays
 res := public.context_ledger_write(run, tok, gen, '[]', jsonb_build_array(jsonb_build_object(
  'item_key', k_omit, 'to_status', 'disputed', 'evidence', pg_temp.pr_cite(), 'reason', 'dispute it')), 'luna-ledger:v1');
 PERFORM pg_temp.pr_assert((res ->> 'transitions_accepted')::int = 1, 'disputed with the opening citation is accepted: ' || res::text);
 SELECT * INTO it FROM public.context_ledger_items i WHERE i.generation_id = gen AND i.item_key = k_omit;
 PERFORM pg_temp.pr_assert(it.status = 'disputed' AND it.person_review ->> 'source_line_id' = 'line-7',
  'a status change that does not name a review leaves it: ' || to_jsonb(it)::text);

 -- back to open, naming null: the review is cleared. evidence is still required
 res := public.context_ledger_write(run, tok, gen, '[]', jsonb_build_array(jsonb_build_object(
  'item_key', k_omit, 'to_status', 'open', 'evidence', pg_temp.pr_cite(), 'person_review', 'null'::jsonb, 'reason', 'open again')),
  'luna-ledger:v1');
 PERFORM pg_temp.pr_assert((res ->> 'transitions_accepted')::int = 1, 'returning to open and clearing the review is accepted: ' || res::text);
 SELECT * INTO it FROM public.context_ledger_items i WHERE i.generation_id = gen AND i.item_key = k_omit;
 PERFORM pg_temp.pr_assert(it.status = 'open' AND it.person_review IS NULL, 'the status change cleared the review');
 led := public.context_job_story_ledger(job, gen, now());
 note := (SELECT x FROM jsonb_array_elements(led -> 'items') x WHERE x ->> 'item_key' = k_omit);
 PERFORM pg_temp.pr_assert(NOT note ? 'person_review' AND note ->> 'status' = 'open',
  'a cleared review is absent from the story ledger: ' || note::text);

 -- a review on an already closed item does not wipe the close.
 -- The row check requires closed_by on a model close, so the fixture supplies one.
 UPDATE public.context_ledger_items SET status = 'closed', closed_at = '2026-10-12 03:00:00+00',
  closed_by = pg_temp.pr_cite()
  WHERE generation_id = gen AND item_key = k_omit;
 res := public.context_ledger_write(run, tok, gen, '[]', jsonb_build_array(jsonb_build_object(
  'item_key', k_omit, 'to_status', 'closed', 'person_review', 'The notes say the width was confirmed.', 'reason', 'review a close')),
  'luna-ledger:v1');
 PERFORM pg_temp.pr_assert((res ->> 'transitions_accepted')::int = 1, 'a review on a closed item needs no evidence: ' || res::text);
 SELECT * INTO it FROM public.context_ledger_items i WHERE i.generation_id = gen AND i.item_key = k_omit;
 PERFORM pg_temp.pr_assert(it.status = 'closed' AND it.closed_at = '2026-10-12 03:00:00+00'
  AND it.closed_by = pg_temp.pr_cite()
  AND it.person_review ->> 'sentence' = 'The notes say the width was confirmed.',
  'the close is kept when the review is set: ' || to_jsonb(it)::text);

 -- a person-locked item still refuses, and the review and the close stay
 UPDATE public.context_ledger_items SET person_locked = true WHERE generation_id = gen AND item_key = k_omit;
 SELECT count(*) INTO n_tr FROM public.context_ledger_transitions t
  JOIN public.context_ledger_items i ON i.id = t.item_id WHERE i.item_key = k_omit;
 review := it.person_review; closed_at := it.closed_at;
 res := public.context_ledger_write(run, tok, gen, '[]', jsonb_build_array(jsonb_build_object(
  'item_key', k_omit, 'to_status', 'closed', 'person_review', 'A later sentence.', 'reason', 'locked')), 'luna-ledger:v1');
 PERFORM pg_temp.pr_assert(res -> 'transitions_refused' -> 0 ->> 'code' = 'person_locked',
  'a person-locked item still refuses a review: ' || res::text);
 SELECT * INTO it FROM public.context_ledger_items i WHERE i.generation_id = gen AND i.item_key = k_omit;
 PERFORM pg_temp.pr_assert(it.person_review = review AND it.closed_at = closed_at AND it.status = 'closed'
  AND (SELECT count(*) FROM public.context_ledger_transitions t WHERE t.item_id = it.id) = n_tr,
  'a refused review leaves the locked item as it was');

 -- the assembler: an open request we owe, with no review, stays a ledger request and leads; one
 -- that carries a review is source person_review, rule claimed_closed_unverified, and does not lead.
 plain := jsonb_build_object('item_key', 'request:gate:plain', 'item_type', 'request', 'status', 'open',
  'from_role', 'customer', 'to_role', 'us', 'what', 'The customer asked us to confirm the gate width.',
  'blocks', 'none', 'needs_reply', true, 'closes_on', 'reply', 'written_by', 'model:luna-ledger:v1', 'cites_ok', true,
  'opened_at', '2026-10-05T01:00:00Z',
  'opened_by', jsonb_build_array(jsonb_build_object('table', 'business_events', 'id', '8fb00000-0000-4000-8000-000000000001',
   'excerpt', 'confirm the gate width', 'customer', true, 'at', '2026-10-05T01:00:00Z')));
 reviewed := plain || jsonb_build_object('item_key', 'request:gate:reviewed',
  'what', 'The customer asked us to confirm the gate colour.',
  'person_review', jsonb_build_object('sentence', 'The notes say the colour was confirmed.',
   'source_line_id', 'line-7', 'reason', 'claimed_closed_unverified', 'raised_at', '2026-10-10T01:00:00Z'));
 asm := public.context_job_story_assemble(
  '{"id":"8f000000-0000-4000-8000-0000000000a1","job_number":"SWF-980101","status":"scheduled","type":"fencing","created_at":"2026-09-01T00:00:00Z"}'::jsonb,
  '{}'::jsonb,
  jsonb_build_object('status', 'live', 'generation', jsonb_build_object('id', 'g1', 'status', 'live'),
   'unread_rows', 0, 'items', jsonb_build_array(plain, reviewed), 'transitions', '[]'::jsonb),
  '{}'::jsonb, '2026-10-18T04:00:00Z', NULL);
 note := (SELECT x FROM jsonb_array_elements(asm -> 'loops') x WHERE x ->> 'key' = 'request:gate:plain');
 PERFORM pg_temp.pr_assert(note ->> 'source' = 'ledger' AND note ->> 'rule' = 'request'
  AND note ->> 'owner' = 'us' AND note ->> 'counterparty' = 'customer',
  'an open request with no review still counts: ' || note::text);
 note := (SELECT x FROM jsonb_array_elements(asm -> 'loops') x WHERE x ->> 'key' = 'request:gate:reviewed');
 PERFORM pg_temp.pr_assert(note ->> 'source' = 'person_review' AND note ->> 'rule' = 'claimed_closed_unverified'
  AND note ->> 'owner' = 'us' AND note ->> 'counterparty' = 'customer' AND note ->> 'status' = 'open'
  AND (note ->> 'rank')::int > (SELECT (x ->> 'rank')::int FROM jsonb_array_elements(asm -> 'loops') x WHERE x ->> 'key' = 'request:gate:plain'),
  'a request that carries a review is a person review and does not lead the unreviewed ask: ' || note::text);
 PERFORM pg_temp.pr_assert(asm -> 'now' ->> 'whose_move' = 'us'
  AND asm #>> '{now,next,what}' = 'The customer asked us to confirm the gate width.'
  AND position('we owe:' IN asm #>> '{now,line}') > 0
  AND position('gate colour' IN coalesce(asm #>> '{now,next,what}', '')) = 0,
  'the unreviewed ask is still ours to the customer: ' || (asm -> 'now')::text);

 -- an empty object, a missing raised_at, a non-timestamp and a sentence string are not a review
 asm := public.context_job_story_assemble(
  '{"id":"8f000000-0000-4000-8000-0000000000a1","job_number":"SWF-980101","status":"scheduled","type":"fencing","created_at":"2026-09-01T00:00:00Z"}'::jsonb,
  '{}'::jsonb,
  jsonb_build_object('status', 'live', 'generation', jsonb_build_object('id', 'g1', 'status', 'live'),
   'unread_rows', 0, 'transitions', '[]'::jsonb, 'items', jsonb_build_array(
    plain || jsonb_build_object('item_key', 'request:gate:empty', 'what', 'The customer asked us to confirm the gate latch.',
     'person_review', '{}'::jsonb),
    plain || jsonb_build_object('item_key', 'request:gate:missing-at', 'what', 'The customer asked us to confirm the gate hinge.',
     'person_review', jsonb_build_object('sentence', 'The notes say the hinge was confirmed.', 'reason', 'claimed_closed_unverified')),
    plain || jsonb_build_object('item_key', 'request:gate:bad-at', 'what', 'The customer asked us to confirm the gate post.',
     'person_review', jsonb_build_object('sentence', 'The notes say the post was confirmed.',
      'reason', 'claimed_closed_unverified', 'raised_at', 'not-a-timestamp')),
    plain || jsonb_build_object('item_key', 'request:gate:sentence', 'what', 'The customer asked us to confirm the gate screw.',
     'person_review', to_jsonb('The notes say the screw was confirmed.'::text)))),
  '{}'::jsonb, '2026-10-18T04:00:00Z', NULL);
 PERFORM pg_temp.pr_assert(NOT EXISTS (
   SELECT 1 FROM jsonb_array_elements(asm -> 'loops') x
   WHERE x ->> 'key' IN ('request:gate:empty', 'request:gate:missing-at', 'request:gate:bad-at', 'request:gate:sentence')
     AND (x ->> 'source' IS DISTINCT FROM 'ledger' OR x ->> 'rule' IS DISTINCT FROM 'request')),
  'only a valid review object is a person review: ' || (asm -> 'loops')::text);
END $c$;

-- Wait score. A reviewed attachment does not hide a genuine money loop, and a reviewed unattached
-- invoice does not lead a newer unreviewed request. Item status on the fixture is left open.
DO $wait$
DECLARE
 job jsonb := '{"id":"8f000000-0000-4000-8000-0000000000a1","job_number":"SWF-980101","status":"complete","type":"fencing","created_at":"2026-09-01T00:00:00Z"}';
 facts jsonb := '{"status_completed_at":"2026-10-01T01:00:00Z"}';
 review jsonb := '{"sentence":"The notes say this was already done.","source_line_id":"line-9","reason":"claimed_closed_unverified","raised_at":"2026-10-12T01:00:00Z"}';
 r8 jsonb := jsonb_build_object('rule', 'R8_not_yet_invoiced', 'loop_key', 'R8:final', 'shown_as', 'loop',
  'owner', 'us', 'counterparty', 'customer', 'what', 'Invoice the finished fence.',
  'opened_at', '2026-10-02T01:00:00Z', 'amount', 1500, 'about_key', 'invoice:final',
  'source_table', 'jobs', 'source_id', '8f000000-0000-4000-8000-0000000000a1');
 cite jsonb := jsonb_build_array(jsonb_build_object('table', 'business_events', 'id', '8fb00000-0000-4000-8000-000000000001',
  'excerpt', 'please invoice', 'customer', true, 'at', '2026-10-02T02:00:00Z'));
 ask jsonb := jsonb_build_object('item_key', 'request:r8', 'item_type', 'request', 'status', 'open',
  'from_role', 'customer', 'to_role', 'us', 'what', 'Please invoice the finished fence now.',
  'about_key', 'invoice:final', 'blocks', 'none', 'needs_reply', true, 'closes_on', 'reply',
  'written_by', 'model:luna-ledger:v1', 'cites_ok', true, 'opened_at', '2026-10-02T02:00:00Z', 'opened_by', cite);
 other jsonb := jsonb_build_object('item_key', 'request:r8b', 'item_type', 'request', 'status', 'open',
  'from_role', 'customer', 'to_role', 'us', 'what', 'Please send the invoice copy as well.',
  'about_key', 'invoice:final', 'blocks', 'none', 'needs_reply', true, 'closes_on', 'reply',
  'written_by', 'model:luna-ledger:v1', 'cites_ok', true, 'opened_at', '2026-10-03T02:00:00Z', 'opened_by', cite);
 owe jsonb := jsonb_build_object('item_key', 'commitment:older', 'item_type', 'commitment', 'status', 'open',
  'from_role', 'us', 'to_role', 'customer', 'what', 'We owe the customer the colour chart.',
  'about_key', 'info:colours', 'blocks', 'none', 'needs_reply', false, 'closes_on', 'reply',
  'written_by', 'model:luna-ledger:v1', 'cites_ok', true, 'opened_at', '2026-09-20T01:00:00Z',
  'opened_by', jsonb_build_array(jsonb_build_object('table', 'business_events', 'id', '8fb00000-0000-4000-8000-000000000001',
   'excerpt', 'colour chart', 'at', '2026-09-20T01:00:00Z')));
 led jsonb; asm jsonb; note jsonb; plain jsonb;
BEGIN
 -- every attached open item reviewed: the older commitment leads, the R8 does not, the request is not its own loop
 led := jsonb_build_object('status', 'live', 'generation', jsonb_build_object('id', 'g1', 'status', 'live'),
  'unread_rows', 0, 'items', jsonb_build_array(ask || jsonb_build_object('person_review', review), owe), 'transitions', '[]'::jsonb);
 asm := public.context_job_story_assemble(job, jsonb_build_object('facts', facts, 'loops', jsonb_build_array(r8)), led, '{}'::jsonb, '2026-10-18T04:00:00Z', NULL);
 note := (SELECT x FROM jsonb_array_elements(asm -> 'loops') x WHERE x ->> 'rule' = 'R8_not_yet_invoiced');
 PERFORM pg_temp.pr_assert(note ->> 'source' = 'record' AND note ->> 'rule' = 'R8_not_yet_invoiced' AND note ->> 'status' = 'open'
  AND (note ->> 'rank')::int > 1
  AND (SELECT (x ->> 'rank')::int FROM jsonb_array_elements(asm -> 'loops') x WHERE x ->> 'key' = 'commitment:older') = 1
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(asm -> 'loops') x WHERE x ->> 'key' = 'request:r8')
  AND asm -> 'now' ->> 'whose_move' = 'us'
  AND asm #>> '{now,next,what}' = 'We owe the customer the colour chart.'
  AND asm #>> '{now,next,what}' IS DISTINCT FROM 'Invoice the finished fence.',
  'a reviewed R8 attachment yields the lead to the older commitment: ' || (asm -> 'now')::text || ' / ' || (asm -> 'loops')::text);

 -- no ledger item on the R8: it still ranks first
 led := jsonb_build_object('status', 'live', 'generation', jsonb_build_object('id', 'g1', 'status', 'live'),
  'unread_rows', 0, 'items', jsonb_build_array(owe), 'transitions', '[]'::jsonb);
 asm := public.context_job_story_assemble(job, jsonb_build_object('facts', facts, 'loops', jsonb_build_array(r8)), led, '{}'::jsonb, '2026-10-18T04:00:00Z', NULL);
 PERFORM pg_temp.pr_assert((SELECT (x ->> 'rank')::int FROM jsonb_array_elements(asm -> 'loops') x WHERE x ->> 'rule' = 'R8_not_yet_invoiced') = 1
  AND asm #>> '{now,next,what}' = 'Invoice the finished fence.',
  'a genuine R8 with no attachment still ranks first: ' || (asm -> 'now')::text);

 -- an attached item with no review: the R8 still ranks first
 led := jsonb_build_object('status', 'live', 'generation', jsonb_build_object('id', 'g1', 'status', 'live'),
  'unread_rows', 0, 'items', jsonb_build_array(ask, owe), 'transitions', '[]'::jsonb);
 asm := public.context_job_story_assemble(job, jsonb_build_object('facts', facts, 'loops', jsonb_build_array(r8)), led, '{}'::jsonb, '2026-10-18T04:00:00Z', NULL);
 PERFORM pg_temp.pr_assert((SELECT (x ->> 'rank')::int FROM jsonb_array_elements(asm -> 'loops') x WHERE x ->> 'rule' = 'R8_not_yet_invoiced') = 1
  AND asm #>> '{now,next,what}' = 'Invoice the finished fence.',
  'an unreviewed R8 attachment still ranks first: ' || (asm -> 'loops')::text);

 -- one reviewed and one not: still a leading money loop
 led := jsonb_build_object('status', 'live', 'generation', jsonb_build_object('id', 'g1', 'status', 'live'),
  'unread_rows', 0, 'items', jsonb_build_array(ask || jsonb_build_object('person_review', review), other, owe), 'transitions', '[]'::jsonb);
 asm := public.context_job_story_assemble(job, jsonb_build_object('facts', facts, 'loops', jsonb_build_array(r8)), led, '{}'::jsonb, '2026-10-18T04:00:00Z', NULL);
 PERFORM pg_temp.pr_assert((SELECT (x ->> 'rank')::int FROM jsonb_array_elements(asm -> 'loops') x WHERE x ->> 'rule' = 'R8_not_yet_invoiced') = 1
  AND asm #>> '{now,next,what}' = 'Invoice the finished fence.',
  'a mixed R8 attachment still ranks first: ' || (asm -> 'loops')::text);

 -- unattached reviewed invoice:INV-9 does not lead a newer unreviewed request
 plain := jsonb_build_object('item_key', 'request:newer', 'item_type', 'request', 'status', 'open',
  'from_role', 'customer', 'to_role', 'us', 'what', 'The customer asked us to confirm the gate width.',
  'about_key', 'info:width', 'blocks', 'none', 'needs_reply', true, 'closes_on', 'reply',
  'written_by', 'model:luna-ledger:v1', 'cites_ok', true, 'opened_at', '2026-10-08T01:00:00Z', 'opened_by', cite);
 note := jsonb_build_object('item_key', 'invoice:INV-9', 'item_type', 'request', 'status', 'open',
  'from_role', 'customer', 'to_role', 'us', 'what', 'The customer asked about invoice INV-9.',
  'about_key', 'invoice:INV-9', 'blocks', 'none', 'needs_reply', true, 'closes_on', 'reply',
  'written_by', 'model:luna-ledger:v1', 'cites_ok', true, 'opened_at', '2026-10-01T01:00:00Z',
  'opened_by', cite, 'person_review', review);
 led := jsonb_build_object('status', 'live', 'generation', jsonb_build_object('id', 'g1', 'status', 'live'),
  'unread_rows', 0, 'items', jsonb_build_array(note, plain), 'transitions', '[]'::jsonb);
 asm := public.context_job_story_assemble(job, jsonb_build_object('facts', facts), led, '{}'::jsonb, '2026-10-18T04:00:00Z', NULL);
 PERFORM pg_temp.pr_assert((SELECT (x ->> 'rank')::int FROM jsonb_array_elements(asm -> 'loops') x WHERE x ->> 'key' = 'request:newer') = 1
  AND (SELECT (x ->> 'rank')::int FROM jsonb_array_elements(asm -> 'loops') x WHERE x ->> 'key' = 'invoice:INV-9') = 2
  AND (SELECT x ->> 'source' FROM jsonb_array_elements(asm -> 'loops') x WHERE x ->> 'key' = 'invoice:INV-9') = 'person_review'
  AND (SELECT x ->> 'rule' FROM jsonb_array_elements(asm -> 'loops') x WHERE x ->> 'key' = 'invoice:INV-9') = 'claimed_closed_unverified'
  AND (SELECT x ->> 'status' FROM jsonb_array_elements(asm -> 'loops') x WHERE x ->> 'key' = 'invoice:INV-9') = 'open'
  AND (SELECT x ->> 'status' FROM jsonb_array_elements(asm -> 'loops') x WHERE x ->> 'key' = 'request:newer') = 'open'
  AND asm #>> '{now,next,what}' = 'The customer asked us to confirm the gate width.',
  'a reviewed invoice:INV-9 does not lead a newer unreviewed request: ' || (asm -> 'now')::text || ' / ' || (asm -> 'loops')::text);

 -- an empty object on the only attachment is not a review, so the R8 still leads
 led := jsonb_build_object('status', 'live', 'generation', jsonb_build_object('id', 'g1', 'status', 'live'),
  'unread_rows', 0, 'items', jsonb_build_array(ask || jsonb_build_object('person_review', '{}'::jsonb), owe), 'transitions', '[]'::jsonb);
 asm := public.context_job_story_assemble(job, jsonb_build_object('facts', facts, 'loops', jsonb_build_array(r8)), led, '{}'::jsonb, '2026-10-18T04:00:00Z', NULL);
 PERFORM pg_temp.pr_assert((SELECT (x ->> 'rank')::int FROM jsonb_array_elements(asm -> 'loops') x WHERE x ->> 'rule' = 'R8_not_yet_invoiced') = 1
  AND asm #>> '{now,next,what}' = 'Invoice the finished fence.',
  'an empty review object does not clear a money loop: ' || (asm -> 'now')::text || ' / ' || (asm -> 'loops')::text);
END $wait$;
ROLLBACK;

-- 4. Re-applying the migration changes nothing (its guard accepts its own bodies).
BEGIN;
CREATE TEMP TABLE pr_md5 AS
 SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS m, obj_description(p.oid, 'pg_proc') AS c, p.proacl::text AS acl
 FROM pg_proc p
 WHERE p.oid IN (
  'public.context_ledger_check_item(uuid,jsonb,text,uuid,text)'::regprocedure,
  'public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)'::regprocedure,
  'public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)'::regprocedure,
  'public.context_job_story_ledger(uuid,uuid,timestamptz)'::regprocedure,
  'public.context_ledger_person_review(jsonb,timestamptz)'::regprocedure,
  'public.context_ledger_person_review_ok(jsonb)'::regprocedure);
\ir ../../../migrations/20261019120000_context_ledger_person_review.sql
DO $c$
BEGIN
 PERFORM pg_temp.pr_assert((SELECT count(*) FROM pr_md5) = 6, 'six functions before the re-apply');
 PERFORM pg_temp.pr_assert(NOT EXISTS (SELECT 1 FROM pr_md5 b LEFT JOIN pg_proc p ON p.oid = to_regprocedure(b.sig)
   WHERE p.oid IS NULL OR md5(p.prosrc) <> b.m OR obj_description(p.oid, 'pg_proc') IS DISTINCT FROM b.c
      OR p.proacl::text IS DISTINCT FROM b.acl),
  're-applying changed a body, comment or grant');
 PERFORM pg_temp.pr_assert(EXISTS (SELECT 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'context_ledger_items' AND column_name = 'person_review'),
  're-applying keeps the column');
END $c$;
ROLLBACK;

-- 5. The deploy script refuses a pending file that contains its own transaction, and a caller
--    that includes this file must be able to roll the include back. The pattern is the one
--    scripts/apply-pending-migrations.sh compiles. Paths are from the repository root.
CREATE TEMP TABLE pr_file_b64 (which text, b64 text);
\copy pr_file_b64 FROM PROGRAM 'printf "%s\t%s\n%s\t%s\n" migration "$(base64 -w 0 supabase/migrations/20261019120000_context_ledger_person_review.sql)" script "$(base64 -w 0 scripts/apply-pending-migrations.sh)"'
DO $c$
DECLARE migration text; script text; rx text;
BEGIN
 SELECT convert_from(decode(b64, 'base64'), 'UTF8') INTO migration FROM pr_file_b64 WHERE which = 'migration';
 SELECT convert_from(decode(b64, 'base64'), 'UTF8') INTO script FROM pr_file_b64 WHERE which = 'script';
 PERFORM pg_temp.pr_assert(migration IS NOT NULL AND script IS NOT NULL, 'the migration and the deploy script were read');
 rx := substring(script FROM $re$transaction_control = re\.compile\(\s*r"([^"]+)"$re$);
 PERFORM pg_temp.pr_assert(rx IS NOT NULL, 'the deploy script''s transaction-control pattern was not found');
 PERFORM pg_temp.pr_assert('BEGIN;' ~ rx AND E'COMMIT;\n' ~ rx AND E'  rollback;\n' ~ rx
  AND E'START TRANSACTION;\n' ~ rx, 'the deploy pattern did not match transaction control: ' || rx);
 PERFORM pg_temp.pr_assert(E'BEGIN\n RAISE NOTICE ''x'';\n' !~ rx, 'a plpgsql BEGIN was read as transaction control');
 PERFORM pg_temp.pr_assert(migration !~ rx, 'the migration contains explicit transaction control');
END $c$;

-- An outer transaction that includes the migration rolls the include back with itself.
BEGIN;
CREATE TABLE public.pr1078_tx_probe (id integer PRIMARY KEY);
INSERT INTO public.pr1078_tx_probe VALUES (1);
\ir ../../../migrations/20261019120000_context_ledger_person_review.sql
ROLLBACK;
DO $c$
BEGIN
 PERFORM pg_temp.pr_assert(to_regclass('public.pr1078_tx_probe') IS NULL,
  'an outer rollback after including the migration left the probe table');
END $c$;
