-- Story lead rank contract: which open loop leads the first line (now) and next. The assembler is
-- pure, so every case is a fixture passed in; nothing is written. Fixed as-of instant: Sun 11 Oct
-- 2026 12:00 Perth. Job numbers only, no client details.
BEGIN;
CREATE FUNCTION pg_temp.li(p_key text, p_type text, p_from text, p_to text, p_what text, p_about text, p_blocks text,
  p_opened timestamptz, p_needs_reply boolean DEFAULT false, p_modality text DEFAULT NULL, p_status text DEFAULT 'open',
  p_due date DEFAULT NULL)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $li$
 SELECT jsonb_build_object('item_key', p_key, 'item_type', p_type, 'status', p_status, 'from_role', p_from, 'to_role', p_to,
  'what', p_what, 'about_key', p_about, 'modality', p_modality, 'blocks', coalesce(p_blocks, 'none'), 'opened_at', p_opened,
  'due_date', p_due, 'needs_reply', p_needs_reply, 'closes_on', 'reply', 'written_by', 'luna-ledger:v2', 'cites_ok', true,
  'opened_by', jsonb_build_array(jsonb_build_object('table', 'business_events', 'id', 'ev-' || p_key, 'excerpt', 'words of ' || p_key,
                                                    'customer', p_from = 'customer', 'at', p_opened)))
$li$;
CREATE FUNCTION pg_temp.led(p_items jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $l$
 SELECT jsonb_build_object('status', 'live', 'generation', jsonb_build_object('id', 'g1', 'status', 'live', 'evidence_until', '2026-10-11T02:33:00Z'),
                           'unread_rows', 0, 'unread_ids', '[]'::jsonb, 'read_ids', '[]'::jsonb, 'items', p_items)
$l$;

DO $story$
DECLARE
 asof timestamptz := '2026-10-11T04:00:00Z';
 job jsonb := '{"id":"00000000-0000-4000-8000-000000261469","job_number":"SWF-261469","status":"in_progress","type":"fencing","created_at":"2026-09-22T00:00:00Z"}';
 a text := 'The customer asked to end the fence at the letterbox and drop the jackhammer extra; the shorter run is not yet confirmed.';
 b text := 'The customer asked whether the installer was told to stop the fence at the brickwork; the stop point is unconfirmed.';
 c text := 'The customer reports the fence is loose in three sections and cannot approve it until it is fixed.';
 d text := 'An independent inspection report is expected Mon 12 Oct; a visit is agreed to wait for it.';
 s jsonb; l jsonb; r jsonb; n int;
BEGIN
 -- 1. SWF-261469's shape: an old pre-install ask (5 Oct, blocks install) and its 8 Oct follow-up on
 -- the same object, both still open; the 9 Oct workmanship complaint (blocks completion); the
 -- independent report awaited (10 Oct, blocks completion); the agreed wait (an agreement, not a
 -- loop); and the unaccepted deduction attached to the final balance, which is held (work not done)
 r := jsonb_build_object(
   'loops', jsonb_build_array(jsonb_build_object('rule', 'R8_not_yet_invoiced', 'loop_key', 'R8:261469', 'shown_as', 'loop',
              'owner', 'customer', 'counterparty', 'us', 'what', '$1,342.00 of the job value not yet invoiced', 'why', 'balance after install',
              'opened_at', '2026-09-24T02:00:00Z', 'amount', 1342, 'about_key', 'payment:final-balance', 'closes_when', 'The balance is invoiced',
              'source_table', 'jobs', 'source_id', '00000000-0000-4000-8000-000000261469')));
 l := pg_temp.led(jsonb_build_array(
   pg_temp.li('i-a', 'agreement', 'customer', 'us', a, 'variation:stop-at-letterbox', 'install', '2026-10-05T02:00:00Z', true, 'requested'),
   pg_temp.li('i-b', 'request', 'customer', 'us', b, 'variation:stop-at-letterbox', 'install', '2026-10-08T03:00:00Z', true),
   pg_temp.li('i-c', 'issue', 'customer', 'us', c, 'defect:loose-sections', 'completion', '2026-10-09T06:00:00Z', true),
   pg_temp.li('i-d', 'dependency', 'us', 'third_party', d, 'report:independent-inspection', 'completion', '2026-10-10T03:00:00Z',
              false, NULL, 'open', '2026-10-12'),
   pg_temp.li('i-e', 'agreement', 'us', 'customer', 'Both agreed to wait for the report before a mutually agreed visit.',
              'visit:after-report', 'none', '2026-10-11T01:00:00Z', false, 'agreed'),
   pg_temp.li('i-f', 'claim', 'customer', 'us', 'The customer proposed a deduction from the balance; it is not accepted.',
              'payment:final-balance', 'payment', '2026-10-10T05:00:00Z', true)));
 s := public.context_job_story_assemble(job, r, l, NULL, asof, NULL);
 -- the line: the phase, then the latest agreed position, then our move with the newer completion
 -- complaint (never the 5 Oct install ask); next is the agreed position
 IF position('Our move, we owe: ' || c IN s->'now'->>'line') = 0 OR position(a IN s->'now'->>'line') > 0
    OR position('Latest agreement Sun 11 Oct: Both agreed to wait for the report before a mutually agreed visit. Our move' IN s->'now'->>'line') = 0
    OR s->'now'->'next'->>'what' IS DISTINCT FROM 'Both agreed to wait for the report before a mutually agreed visit.'
    OR s->'now'->'next'->>'kind' IS DISTINCT FROM 'agreement' OR s->'now'->'latest_agreement'->>'key' IS DISTINCT FROM 'i-e'
    OR NOT s->'now'->'cites' @> '[{"t":"business_events","id":"ev-i-e"}]'::jsonb
    OR NOT s->'now'->'cites' @> '[{"t":"business_events","id":"ev-i-c"}]'::jsonb
    OR s->'now'->>'whose_move' IS DISTINCT FROM 'us' THEN
  RAISE EXCEPTION 'story lead rank contract: SWF-261469 shape, the newer completion complaint must lead, not the 5 Oct install ask: %', s->'now';
 END IF;
 -- every loop stays, nothing closed: the 5 Oct ask and its follow-up are still open loops, still
 -- blocking install; overtaken by the newer completion loops they leave now.blockers, which keeps
 -- the completion ones; the held balance ranks last and still carries the unaccepted deduction
 SELECT count(*) INTO n FROM jsonb_array_elements(s->'loops');
 IF n <> 5
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'loops') x WHERE x->>'key' = 'i-a' AND x->>'status' = 'open' AND x->>'blocks' = 'install')
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'loops') x WHERE x->>'key' = 'i-b' AND x->>'status' = 'open' AND x->>'blocks' = 'install')
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(s->'now'->'blockers') x WHERE x->>'what' IN (a, b))
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'now'->'blockers') x WHERE x->>'what' = c)
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'now'->'blockers') x WHERE x->>'what' = d)
    OR position('proposed a deduction' IN (SELECT x->>'why' FROM jsonb_array_elements(s->'loops') x WHERE x->>'key' = 'R8:261469')) = 0
    OR (SELECT (x->>'rank')::int FROM jsonb_array_elements(s->'loops') x WHERE x->>'key' = 'i-c') <> 1
    OR (SELECT (x->>'rank')::int FROM jsonb_array_elements(s->'loops') x WHERE x->>'key' = 'i-d') <> 2
    OR (SELECT (x->>'rank')::int FROM jsonb_array_elements(s->'loops') x WHERE x->>'key' = 'i-a') <> 3
    OR (SELECT (x->>'rank')::int FROM jsonb_array_elements(s->'loops') x WHERE x->>'key' = 'i-b') <> 4
    OR (SELECT x->>'status' FROM jsonb_array_elements(s->'loops') x WHERE x->>'key' = 'R8:261469') IS DISTINCT FROM 'not_due'
    OR (SELECT (x->>'rank')::int FROM jsonb_array_elements(s->'loops') x WHERE x->>'key' = 'R8:261469') <> 5
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'agreements') x WHERE x->>'key' = 'i-e') THEN
  RAISE EXCEPTION 'story lead rank contract: SWF-261469 shape keeps every loop open and ranks the ones that may lead first: %', s->'loops';
 END IF;

 -- 2. Of the open loops on one object only the newest leads (no stages involved): the customer's
 -- follow-up of 3 Oct leads over their first ask of 1 Oct on the same quote
 l := pg_temp.led(jsonb_build_array(
   pg_temp.li('q-1', 'request', 'customer', 'us', 'The customer asked for a revised quote without the gate.', 'quote:rear-fence', NULL, '2026-10-01T02:00:00Z'),
   pg_temp.li('q-2', 'request', 'customer', 'us', 'The customer asked again for the revised quote, now with a lower fence.', 'quote:rear-fence', NULL, '2026-10-03T02:00:00Z'),
   pg_temp.li('q-3', 'dependency', 'us', 'third_party', 'The supplier is to confirm the panel colour.', 'supply:panels', NULL, '2026-09-30T02:00:00Z'),
   -- a recent agreement older than our newer open ask is not the latest position: what we owe is newer
   pg_temp.li('q-4', 'agreement', 'us', 'customer', 'Both agreed the gate stays out of the quote.', 'quote:rear-fence-gate', NULL,
              '2026-10-02T02:00:00Z', false, 'agreed', 'info')));
 s := public.context_job_story_assemble(job, '{}'::jsonb, l, NULL, asof, NULL);
 IF s->'now'->'next'->>'what' IS DISTINCT FROM 'The customer asked again for the revised quote, now with a lower fence.'
    OR position('Latest agreement' IN s->'now'->>'line') > 0
    OR (SELECT count(*) FROM jsonb_array_elements(s->'loops')) <> 3 THEN
  RAISE EXCEPTION 'story lead rank contract: only the newest open loop on one object leads: %', s->'now';
 END IF;

 -- 3. Control: loops on different objects with no stage keep the earlier order (oldest first); an
 -- agreement older than 14 days, or one superseded since, is never the latest agreed position
 l := pg_temp.led(jsonb_build_array(
   pg_temp.li('k-1', 'request', 'customer', 'us', 'The customer asked for the colour chart.', 'info:colours', NULL, '2026-10-01T02:00:00Z'),
   pg_temp.li('k-2', 'request', 'customer', 'us', 'The customer asked for the warranty terms.', 'info:warranty', NULL, '2026-10-03T02:00:00Z')));
 l := jsonb_set(l, '{items}', (l->'items')
   || jsonb_build_array(pg_temp.li('k-3', 'agreement', 'us', 'customer', 'Install agreed for Fri 25 Sep.', 'booking:install', NULL, '2026-09-20T02:00:00Z', false, 'agreed', 'info'),
                        pg_temp.li('k-4', 'agreement', 'us', 'customer', 'Install agreed for Fri 16 Oct.', 'booking:install-2', NULL, '2026-10-05T02:00:00Z', false, 'agreed', 'superseded')));
 s := public.context_job_story_assemble(job, '{}'::jsonb, l, NULL, asof, NULL);
 IF s->'now'->'next'->>'what' IS DISTINCT FROM 'The customer asked for the colour chart.'
    OR position('Latest agreement' IN s->'now'->>'line') > 0 OR s->'now'->'latest_agreement' IS DISTINCT FROM 'null'::jsonb
    OR (SELECT string_agg(x->>'key', ',' ORDER BY (x->>'rank')::int) FROM jsonb_array_elements(s->'loops') x) IS DISTINCT FROM 'k-1,k-2' THEN
  RAISE EXCEPTION 'story lead rank contract: unrelated loops keep the oldest first: %', s->'loops';
 END IF;

 -- 4. Only a newer LATER stage stops a loop leading: the booking ask (1 Oct) yields to the install
 -- issue (3 Oct), but the install issue does not yield to a newer deposit question (5 Oct, an
 -- earlier stage), so the install issue leads
 l := pg_temp.led(jsonb_build_array(
   pg_temp.li('s-1', 'request', 'customer', 'us', 'The customer asked to move the booking.', 'booking:install-day', 'booking', '2026-10-01T02:00:00Z'),
   pg_temp.li('s-2', 'issue', 'customer', 'us', 'The customer says the post holes were left open.', 'defect:post-holes', 'install', '2026-10-03T02:00:00Z', true),
   pg_temp.li('s-3', 'request', 'customer', 'us', 'The customer asked how the deposit was applied.', 'invoice:deposit', 'deposit', '2026-10-05T02:00:00Z')));
 s := public.context_job_story_assemble(job, '{}'::jsonb, l, NULL, asof, NULL);
 IF s->'now'->'next'->>'what' IS DISTINCT FROM 'The customer says the post holes were left open.'
    OR (SELECT (x->>'rank')::int FROM jsonb_array_elements(s->'loops') x WHERE x->>'key' = 's-1') <> 3 THEN
  RAISE EXCEPTION 'story lead rank contract: only a newer later-stage loop stops one leading: %', s->'loops';
 END IF;

 -- 5. The party comes first: our only open loop (an install ask, 1 Oct) may not lead under the
 -- customer's newer payment promise (4 Oct), yet it is our move, so our loop is still the top and the
 -- line never pairs our move with the customer's item
 l := pg_temp.led(jsonb_build_array(
   pg_temp.li('p-1', 'request', 'customer', 'us', 'The customer asked us to confirm the gate position.', 'install:gate', 'install', '2026-10-01T02:00:00Z'),
   pg_temp.li('p-2', 'commitment', 'customer', 'us', 'The customer said they will pay the balance after the inspection.', 'payment:balance', 'payment', '2026-10-04T02:00:00Z')));
 s := public.context_job_story_assemble(job, '{}'::jsonb, l, NULL, asof, NULL);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'us' OR s->'now'->'next'->>'what' IS DISTINCT FROM 'The customer asked us to confirm the gate position.'
    OR position('Our move, we owe: ' IN s->'now'->>'line') = 0
    OR (SELECT string_agg(x->>'key', ',' ORDER BY (x->>'rank')::int) FROM jsonb_array_elements(s->'loops') x) IS DISTINCT FROM 'p-2,p-1' THEN
  RAISE EXCEPTION 'story lead rank contract: the party whose move it is still comes first: %', s->'now';
 END IF;
END $story$;

-- Access and inlinability are unchanged: service role only, no SET clause, STABLE
DO $access$
DECLARE sig text := 'public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)';
BEGIN
 IF has_function_privilege('anon', sig, 'EXECUTE') OR has_function_privilege('authenticated', sig, 'EXECUTE')
    OR NOT has_function_privilege('service_role', sig, 'EXECUTE')
    OR (SELECT p.proconfig IS NOT NULL OR p.provolatile <> 's' FROM pg_proc p WHERE p.oid = to_regprocedure(sig))
    OR coalesce(obj_description(to_regprocedure(sig), 'pg_proc'), '') NOT LIKE '%(story lead rank, 20261011100000)%' THEN
  RAISE EXCEPTION 'story lead rank contract: access, volatility or comment of the assembler is wrong';
 END IF;
END $access$;
ROLLBACK;
