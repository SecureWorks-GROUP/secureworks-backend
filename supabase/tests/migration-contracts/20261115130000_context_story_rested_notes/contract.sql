-- Rested notes contract: the job story sets aside the AI notes that are not something anyone owes now
-- (a thing somebody said, a matter for a step the job has passed, a note older than the policy's
-- days), and lists them under rested with the reason. Money, a person's own note and a fresh note
-- stay open. A job with none reads exactly as before. Fixed as-of instant: Sun 11 Oct 2026 12:00
-- Perth. Job numbers only, invented words, nothing is written outside a rolled-back transaction.
BEGIN;
CREATE FUNCTION pg_temp.li(p_key text, p_type text, p_from text, p_to text, p_what text, p_about text, p_blocks text,
  p_opened timestamptz, p_needs_reply boolean DEFAULT false, p_due date DEFAULT NULL, p_extra jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $li$
 SELECT jsonb_build_object('item_key', p_key, 'item_type', p_type, 'status', 'open', 'from_role', p_from, 'to_role', p_to,
  'what', p_what, 'about_key', p_about, 'modality', NULL, 'blocks', coalesce(p_blocks, 'none'), 'opened_at', p_opened,
  'due_date', p_due, 'needs_reply', p_needs_reply, 'closes_on', 'reply', 'written_by', 'luna-ledger:v2', 'cites_ok', true,
  'opened_by', jsonb_build_array(jsonb_build_object('table', 'business_events', 'id', 'ev-' || p_key, 'excerpt', 'words of ' || p_key,
                                                    'customer', p_from = 'customer', 'at', p_opened))) || p_extra
$li$;
CREATE FUNCTION pg_temp.led(p_items jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $l$
 SELECT jsonb_build_object('status', 'live', 'generation', jsonb_build_object('id', 'g1', 'status', 'live', 'evidence_until', '2026-10-11T02:33:00Z'),
                           'unread_rows', 0, 'unread_ids', '[]'::jsonb, 'read_ids', '[]'::jsonb, 'items', p_items)
$l$;
CREATE FUNCTION pg_temp.items() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $i$
 SELECT jsonb_build_array(
  pg_temp.li('k-said', 'claim', 'customer', 'us', 'The customer said the dog is friendly.', 'site:dog', 'none', '2026-10-09T02:00:00Z'),
  pg_temp.li('k-claimreply', 'claim', 'customer', 'us', 'The customer says the gate is the wrong colour.', 'gate:colour', 'completion', '2026-10-09T02:00:00Z', true),
  pg_temp.li('k-stage', 'request', 'customer', 'us', 'The customer asked for a revised quote with a taller fence.', 'quote:taller', 'acceptance', '2026-09-20T02:00:00Z', true),
  pg_temp.li('k-stagenew', 'request', 'customer', 'us', 'The customer asked to see the booking slip again.', 'booking:slip', 'booking', '2026-10-05T02:00:00Z', true),
  pg_temp.li('k-old', 'commitment', 'us', 'customer', 'We said we would send the colour chart.', 'chart:colour', 'none', '2026-08-20T02:00:00Z'),
  pg_temp.li('k-oldmoney', 'request', 'us', 'customer', 'We asked for the deposit to be paid.', 'payment:deposit', 'deposit', '2026-08-20T02:00:00Z', true),
  pg_temp.li('k-fresh', 'request', 'customer', 'us', 'The customer asked when the crew arrives on Wednesday.', 'booking:wednesday', 'install', '2026-10-10T02:00:00Z', true),
  pg_temp.li('k-olddue', 'commitment', 'us', 'customer', 'We will come back to fix the latch.', 'defect:latch', 'completion', '2026-08-20T02:00:00Z', false, '2026-10-20'),
  pg_temp.li('k-person', 'commitment', 'us', 'customer', 'Call the neighbour about the boundary.', 'neighbour:call', 'none', '2026-08-01T02:00:00Z', false, NULL,
             '{"written_by":"person:00000000-0000-4000-8000-000000000001"}'))
$i$;
CREATE FUNCTION pg_temp.rec() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $r$
 SELECT jsonb_build_object('loops', '[]'::jsonb, 'facts', jsonb_build_object('bookings', jsonb_build_array(
   jsonb_build_object('id', 'b1', 'scheduled_date', '2026-10-01', 'status', 'in_progress', 'started_at', '2026-10-01T00:30:00Z', 'created_at', '2026-09-25T00:00:00Z'),
   jsonb_build_object('id', 'b2', 'scheduled_date', '2026-10-14', 'status', 'scheduled', 'created_at', '2026-09-25T00:00:00Z'))))
$r$;

DO $c$
DECLARE
 asof timestamptz := '2026-10-11T04:00:00Z';
 job jsonb := '{"id":"00000000-0000-4000-8000-000000971301","job_number":"SWF-971301","status":"in_progress","type":"fencing","created_at":"2026-08-01T00:00:00Z"}';
 l jsonb := pg_temp.led(pg_temp.items());
 s jsonb; r jsonb; s2 jsonb; keys text;
BEGIN
 -- the policy: the numbers live in one place
 IF (public.context_job_story_rest_policy() ->> 'max_age_days')::int <> 30
    OR public.context_job_story_rest_policy() #>> '{passed,install}' <> '4' THEN
  RAISE EXCEPTION 'rested notes contract: policy numbers wrong: %', public.context_job_story_rest_policy();
 END IF;
 s := public.context_job_story_assemble(job, pg_temp.rec(), l, NULL, asof, NULL);
 IF s->'now'->>'phase' <> 'install' OR s->'now'->>'phase_since' <> '2026-10-01' OR jsonb_array_length(s->'loops') <> 9 THEN
  RAISE EXCEPTION 'rested notes contract: fixture card is not the install shape it should be: % % %', s->'now'->>'phase', s->'now'->>'phase_since', jsonb_array_length(s->'loops');
 END IF;
 r := public.context_job_story_rest(l, s, asof);
 -- 1. a claim with no reply owed is set aside as said
 IF (r->'rested' @> '[{"key":"k-said","reason":"said"}]'::jsonb) IS NOT TRUE THEN
  RAISE EXCEPTION 'rested notes contract: a thing somebody said, with no reply owed, must be set aside as said: %', r->'rested';
 END IF;
 -- 2. a matter that held up acceptance, raised before the install began, is set aside; one raised after it is not
 IF (r->'rested' @> '[{"key":"k-stage","reason":"stage_passed"}]'::jsonb) IS NOT TRUE
    OR (position('acceptance of the quote' IN (SELECT e->>'why' FROM jsonb_array_elements(r->'rested') e WHERE e->>'key' = 'k-stage')) > 0) IS NOT TRUE THEN
  RAISE EXCEPTION 'rested notes contract: a matter for a step the job has passed must be set aside: %', r->'rested';
 END IF;
 -- 3. an unconfirmed note more than 30 days old is set aside, saying its age
 IF (r->'rested' @> '[{"key":"k-old","reason":"old","age_days":52}]'::jsonb) IS NOT TRUE THEN
  RAISE EXCEPTION 'rested notes contract: a 52-day-old note must be set aside as old: %', r->'rested';
 END IF;
 -- 4. exactly those three, newest first; money, a reply owed, a fresh note, a later due day and a
 -- person's own note all stay
 SELECT string_agg(e->>'key', ',' ORDER BY o) INTO keys FROM jsonb_array_elements(r->'rested') WITH ORDINALITY x(e, o);
 IF keys IS DISTINCT FROM 'k-said,k-stage,k-old' THEN
  RAISE EXCEPTION 'rested notes contract: set aside %, expected k-said,k-stage,k-old', keys;
 END IF;
 -- 5. the ledger handed back marks those three rested, keeps every other item as it was, in order
 IF (SELECT string_agg(i->>'item_key' || ':' || (i->>'status'), ',' ORDER BY o) FROM jsonb_array_elements(r->'ledger'->'items') WITH ORDINALITY x(i, o))
    IS DISTINCT FROM 'k-said:rested,k-claimreply:open,k-stage:rested,k-stagenew:open,k-old:rested,k-oldmoney:open,k-fresh:open,k-olddue:open,k-person:open'
    OR r->'ledger'->'generation' IS DISTINCT FROM l->'generation' THEN
  RAISE EXCEPTION 'rested notes contract: ledger handed back wrong: %', r->'ledger';
 END IF;
 -- 6. assembled again: the three are no longer open items, the rest keep their order
 s2 := public.context_job_story_assemble(job, pg_temp.rec(), r->'ledger', NULL, asof, NULL);
 IF (SELECT string_agg(e->>'key', ',' ORDER BY (e->>'rank')::int) FROM jsonb_array_elements(s2->'loops') e)
    IS DISTINCT FROM 'k-claimreply,k-fresh,k-person,k-olddue,k-stagenew,k-oldmoney' THEN
  RAISE EXCEPTION 'rested notes contract: second card loops wrong: %', s2->'loops';
 END IF;
 -- 7. nothing to set aside: NULL, so the story is the first card unchanged
 IF public.context_job_story_rest(pg_temp.led(jsonb_build_array(pg_temp.items()->6)),
      public.context_job_story_assemble(job, pg_temp.rec(), pg_temp.led(jsonb_build_array(pg_temp.items()->6)), NULL, asof, NULL), asof) IS NOT NULL
    OR public.context_job_story_rest(pg_temp.led('[]'), s, asof) IS NOT NULL
    OR public.context_job_story_rest(jsonb_build_object('status', 'none'), s, asof) IS NOT NULL THEN
  RAISE EXCEPTION 'rested notes contract: a ledger with nothing to set aside must give NULL';
 END IF;
END $c$;

-- The guards, on a card given directly (the function is pure): a claim whose reply mark is unset or
-- that blocks a step stays; a note with closing evidence waiting is never called old; a note whose
-- words carry a dollar amount or that is about a refund is money; the 30-day line is a Perth day.
DO $c$
DECLARE
 asof timestamptz := '2026-10-11T04:00:00Z';
 ln jsonb; st jsonb; r jsonb; keys text;
BEGIN
 ln := pg_temp.led(jsonb_build_array(
  pg_temp.li('g-said', 'claim', 'customer', 'us', 'The customer said the side path is narrow.', 'site:path', 'none', '2026-10-09T02:00:00Z'),
  pg_temp.li('g-nullreply', 'claim', 'customer', 'us', 'The customer said the side gate sticks.', 'site:gate', 'none', '2026-10-09T02:00:00Z', NULL),
  pg_temp.li('g-claimblocks', 'claim', 'customer', 'us', 'The customer said a post is loose.', 'defect:post', 'completion', '2026-10-09T02:00:00Z'),
  pg_temp.li('g-closing', 'commitment', 'us', 'customer', 'We said we would send the warranty.', 'doc:warranty', 'none', '2026-08-20T02:00:00Z'),
  pg_temp.li('g-dollar', 'commitment', 'us', 'customer', 'We said we would take $150 off for the delay.', 'discount:delay', 'none', '2026-08-20T02:00:00Z'),
  pg_temp.li('g-refund', 'commitment', 'us', 'customer', 'We said we would refund the hire.', 'refund:hire', 'none', '2026-08-20T02:00:00Z'),
  pg_temp.li('g-day30', 'commitment', 'us', 'customer', 'We said we would check the levels.', 'site:levels', 'none', '2026-09-10T16:00:00Z'),
  pg_temp.li('g-day31', 'commitment', 'us', 'customer', 'We said we would check the drainage.', 'site:drainage', 'none', '2026-09-10T15:59:00Z')));
 st := jsonb_build_object('now', jsonb_build_object('phase', 'install', 'phase_since', '2026-10-01'), 'loops',
  (SELECT jsonb_agg(jsonb_build_object('key', i->>'item_key', 'source', 'ledger', 'rule', i->>'item_type', 'what', i->>'what',
     'since', i->>'opened_at', 'blocks', i->>'blocks', 'about_key', i->>'about_key',
     'status', CASE WHEN i->>'item_key' = 'g-closing' THEN 'closing_evidence' ELSE 'open' END) ORDER BY o)
   FROM jsonb_array_elements(ln->'items') WITH ORDINALITY x(i, o)));
 r := public.context_job_story_rest(ln, st, asof);
 SELECT string_agg((e->>'key') || ':' || (e->>'reason'), ',' ORDER BY o) INTO keys FROM jsonb_array_elements(r->'rested') WITH ORDINALITY x(e, o);
 IF keys IS DISTINCT FROM 'g-said:said,g-day31:old' THEN
  RAISE EXCEPTION 'rested notes contract: guards wrong: set aside %, expected g-said:said,g-day31:old', keys;
 END IF;
 IF (SELECT (e->>'age_days')::int FROM jsonb_array_elements(r->'rested') e WHERE e->>'key' = 'g-day31') IS DISTINCT FROM 31 THEN
  RAISE EXCEPTION 'rested notes contract: the 31-day note must say 31 days: %', r->'rested';
 END IF;
 -- no phase on the card: only said and old can apply, and nothing fails
 r := public.context_job_story_rest(ln, st - 'now', asof);
 SELECT string_agg(e->>'key', ',' ORDER BY o) INTO keys FROM jsonb_array_elements(r->'rested') WITH ORDINALITY x(e, o);
 IF keys IS DISTINCT FROM 'g-said,g-day31' THEN
  RAISE EXCEPTION 'rested notes contract: a card with no phase set aside %', keys;
 END IF;
END $c$;
ROLLBACK;

-- The story read end to end: the ledger read stubbed inside this transaction, the job a real row.
BEGIN;
INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, site_suburb, metadata, created_at)
VALUES ('00000000-0000-4000-8000-000000971301', '00000000-0000-0000-0000-000000000001', 'in_progress', 'fencing', 'SWF-971301',
        'Pat Example', 'Testville', '{}', '2026-08-01T00:00:00Z');
CREATE TEMP TABLE before_stub AS
 SELECT public.context_job_story('00000000-0000-4000-8000-000000971301', '2026-10-11T04:00:00Z') AS s;
CREATE OR REPLACE FUNCTION public.context_job_story_ledger(p_job_id uuid, p_generation_id uuid DEFAULT NULL, p_as_of timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
 SELECT jsonb_build_object('status', 'live', 'generation', jsonb_build_object('id', 'g1', 'status', 'live', 'evidence_until', '2026-10-11T02:33:00Z'),
   'unread_rows', 0, 'unread_ids', '[]'::jsonb, 'read_ids', '[]'::jsonb, 'items', jsonb_build_array(
   jsonb_build_object('item_key', 'k-said', 'item_type', 'claim', 'status', 'open', 'from_role', 'customer', 'to_role', 'us',
    'what', 'The customer said the dog is friendly.', 'about_key', 'site:dog', 'blocks', 'none', 'opened_at', '2026-10-09T02:00:00Z',
    'needs_reply', false, 'closes_on', 'reply', 'written_by', 'luna-ledger:v2', 'cites_ok', true, 'opened_by', '[]'::jsonb),
   jsonb_build_object('item_key', 'k-fresh', 'item_type', 'request', 'status', 'open', 'from_role', 'customer', 'to_role', 'us',
    'what', 'The customer asked when the crew arrives on Wednesday.', 'about_key', 'booking:wednesday', 'blocks', 'install',
    'opened_at', '2026-10-10T02:00:00Z', 'needs_reply', true, 'closes_on', 'reply', 'written_by', 'luna-ledger:v2', 'cites_ok', true, 'opened_by', '[]'::jsonb)))
$fn$;
DO $c$
DECLARE s jsonb; ro jsonb; b jsonb;
BEGIN
 SELECT before_stub.s INTO b FROM before_stub;
 -- a job with no AI notes carries no rested key
 IF b IS NULL OR b ? 'rested' THEN
  RAISE EXCEPTION 'rested notes contract: a job with no notes must read without rested: %', b ? 'rested';
 END IF;
 s := public.context_job_story('00000000-0000-4000-8000-000000971301', '2026-10-11T04:00:00Z');
 IF (s->'rested' @> '[{"key":"k-said","reason":"said"}]'::jsonb AND jsonb_array_length(s->'rested') = 1) IS NOT TRUE
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(s->'loops') e WHERE e->>'key' = 'k-said')
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'loops') e WHERE e->>'key' = 'k-fresh') THEN
  RAISE EXCEPTION 'rested notes contract: the story read must set the said note aside and keep the fresh one: % %', s->'rested', s->'loops';
 END IF;
 -- the records-only read never carries rested
 ro := public.context_job_story('00000000-0000-4000-8000-000000971301', '2026-10-11T04:00:00Z', NULL, NULL, true);
 IF ro IS NULL OR ro ? 'rested' THEN
  RAISE EXCEPTION 'rested notes contract: the records-only read must carry no rested';
 END IF;
 IF public.context_job_story('00000000-0000-4000-8000-0000000fffff', '2026-10-11T04:00:00Z') IS NOT NULL THEN
  RAISE EXCEPTION 'rested notes contract: an unknown job must still read NULL';
 END IF;
END $c$;
-- a set aside note a held message still holds up keeps its job not certain mark: the held-marks
-- read is stubbed here to hold k-said, so only the wiring is under test
CREATE OR REPLACE FUNCTION public.context_job_story_held_marks(p_story jsonb, p_job_id uuid, p_as_of timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
 SELECT CASE WHEN jsonb_typeof(p_story -> 'loops') = 'array' THEN jsonb_set(p_story, '{loops}', (SELECT coalesce(jsonb_agg(CASE WHEN a.x ->> 'key' = 'k-said'
   THEN a.x || '{"job_certain":false,"certainty":"job_not_certain"}'::jsonb ELSE a.x END ORDER BY a.o), '[]'::jsonb)
   FROM jsonb_array_elements(p_story -> 'loops') WITH ORDINALITY a(x, o))) ELSE p_story END
$fn$;
DO $c$
DECLARE s jsonb;
BEGIN
 s := public.context_job_story('00000000-0000-4000-8000-000000971301', '2026-10-11T04:00:00Z');
 IF (s->'rested' @> '[{"key":"k-said","job_certain":false,"certainty":"job_not_certain"}]'::jsonb) IS NOT TRUE THEN
  RAISE EXCEPTION 'rested notes contract: a held note set aside must keep its job not certain mark: %', s->'rested';
 END IF;
END $c$;
ROLLBACK;

-- A job whose live AI notes hold nothing to set aside reads exactly as the earlier story did:
-- measured against this migration's own down, inside a rolled-back transaction.
BEGIN;
INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, site_suburb, metadata, created_at)
VALUES ('00000000-0000-4000-8000-000000971302', '00000000-0000-0000-0000-000000000001', 'scheduled', 'fencing', 'SWF-971302',
        'Lee Example', 'Testville', '{}', '2026-09-01T00:00:00Z');
-- the AI notes are live and hold one fresh request, which nothing sets aside
CREATE OR REPLACE FUNCTION public.context_job_story_ledger(p_job_id uuid, p_generation_id uuid DEFAULT NULL, p_as_of timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
 SELECT jsonb_build_object('status', 'live', 'generation', jsonb_build_object('id', 'g1', 'status', 'live', 'evidence_until', '2026-10-11T02:33:00Z'),
   'unread_rows', 0, 'unread_ids', '[]'::jsonb, 'read_ids', '[]'::jsonb, 'items', jsonb_build_array(
   jsonb_build_object('item_key', 'k-fresh', 'item_type', 'request', 'status', 'open', 'from_role', 'customer', 'to_role', 'us',
    'what', 'The customer asked when the crew arrives on Wednesday.', 'about_key', 'booking:wednesday', 'blocks', 'install',
    'opened_at', '2026-10-10T02:00:00Z', 'needs_reply', true, 'closes_on', 'reply', 'written_by', 'luna-ledger:v2', 'cites_ok', true, 'opened_by', '[]'::jsonb)))
$fn$;
CREATE TEMP TABLE now_story AS SELECT public.context_job_story('00000000-0000-4000-8000-000000971302', '2026-10-11T04:00:00Z') AS s;
DO $c$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM now_story, jsonb_array_elements(now_story.s->'loops') e WHERE e->>'key' = 'k-fresh') THEN
  RAISE EXCEPTION 'rested notes contract: the identity case must carry a live AI note';
 END IF;
END $c$;
\ir ../../../rollbacks/20261115130000_context_story_rested_notes_down.sql
DO $c$
BEGIN
 IF (SELECT s FROM now_story) IS DISTINCT FROM public.context_job_story('00000000-0000-4000-8000-000000971302', '2026-10-11T04:00:00Z') THEN
  RAISE EXCEPTION 'rested notes contract: a job with nothing to set aside must read exactly as before';
 END IF;
END $c$;
ROLLBACK;

-- Grants and the comment: service role only, slice name kept first
DO $c$
BEGIN
 IF has_function_privilege('anon', 'public.context_job_story_rest(jsonb,jsonb,timestamptz)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.context_job_story_rest_policy()', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.context_job_story_rest(jsonb,jsonb,timestamptz)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)', 'EXECUTE') THEN
  RAISE EXCEPTION 'rested notes contract: grants wrong';
 END IF;
 IF obj_description('public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)'::regprocedure, 'pg_proc') NOT LIKE 'Job story (20261006014000)%Rested notes (20261115130000)%' THEN
  RAISE EXCEPTION 'rested notes contract: the story comment must keep its slice name first and name this slice';
 END IF;
END $c$;
