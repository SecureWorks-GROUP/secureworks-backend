-- Contract for 20261015100000_context_held_notes: a message held on no job may open a note on each
-- job it could belong to, marked job not certain, behind feature_flags.context_held_notes_v1.
-- Every fixture write is rolled back. Invented names only.

CREATE FUNCTION pg_temp.hn_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'held notes contract: %', p_msg; END IF; END $$;
CREATE FUNCTION pg_temp.hn_job(p_id uuid, p_number text, p_created timestamptz) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, client_email, ghl_contact_id, site_suburb, metadata, created_at)
 VALUES (p_id, '00000000-0000-0000-0000-000000000001', 'scheduled', 'fencing', p_number, 'Robin Twojobs', 'robin.twojobs@example.test',
  'hn-ct-robin', 'Testville', '{}', p_created);
 RETURN p_id;
END $$;
-- A message row, every column the store reads stated: placed on p_job, or held (p_job null) with p_candidates.
CREATE FUNCTION pg_temp.hn_ev(p_id uuid, p_job uuid, p_type text, p_channel text, p_direction text, p_body text, p_at timestamptz,
 p_candidates uuid[] DEFAULT NULL, p_payload jsonb DEFAULT '{}', p_provider text DEFAULT NULL, p_contact text DEFAULT 'hn-ct-robin')
RETURNS uuid LANGUAGE plpgsql SET session_replication_role = replica AS $$
BEGIN
 INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, provider_message_id, payload, metadata,
  occurred_at, event_at, recorded_at, context_captured_at, attribution_status, attribution_step, attribution_confidence, attributed_at,
  match_method, candidate_job_ids)
 VALUES (p_id, p_job, p_type, 'ledger_contract', p_channel, p_direction, p_contact, p_provider,
  CASE WHEN p_type = 'call.transcript_completed' THEN jsonb_build_object('transcript', p_body) ELSE jsonb_build_object('body', p_body) END || p_payload,
  jsonb_build_object('written_as', 'service_role', 'party_roles', jsonb_build_object('version', 'party_roles_v4',
    'basis', CASE WHEN p_job IS NULL THEN 'any_job_customer' ELSE 'job_customer' END, 'counterpart_role', 'customer', 'audience', 'customer',
    'sender_role', CASE WHEN p_direction = 'inbound' THEN 'customer' ELSE 'staff' END,
    'recipient_role', CASE WHEN p_direction = 'inbound' THEN 'staff' ELSE 'customer' END))
   || CASE WHEN p_job IS NULL THEN jsonb_build_object('placement_rule', 'review_several') ELSE '{}'::jsonb END,
  p_at, p_at, p_at, p_at, CASE WHEN p_job IS NULL THEN 'unplaced' ELSE 'direct' END, 1,
  CASE WHEN p_job IS NULL THEN NULL ELSE 1 END, CASE WHEN p_job IS NULL THEN NULL ELSE p_at END,
  CASE WHEN p_job IS NULL THEN NULL ELSE 'direct_job_id' END, p_candidates);
 RETURN p_id;
END $$;
-- The placement ladder's later answer: the held row is placed on one job.
CREATE FUNCTION pg_temp.hn_place(p_id uuid, p_job uuid) RETURNS void LANGUAGE plpgsql SET session_replication_role = replica AS $$
BEGIN
 UPDATE public.business_events SET job_id = p_job, attribution_status = 'direct', attribution_confidence = 1, attributed_at = now(),
  match_method = 'direct_job_id', metadata = jsonb_set(metadata, '{party_roles,basis}', '"job_customer"')
 WHERE id = p_id;
END $$;
CREATE FUNCTION pg_temp.hn_hold(p_id uuid) RETURNS void LANGUAGE plpgsql SET session_replication_role = replica AS $$
BEGIN
 UPDATE public.business_events SET job_id = NULL, attribution_status = 'unplaced', attribution_confidence = NULL, attributed_at = NULL,
  match_method = NULL, metadata = jsonb_set(metadata, '{party_roles,basis}', '"any_job_customer"')
 WHERE id = p_id;
END $$;
CREATE FUNCTION pg_temp.hn_meta() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('model', 'gpt-6-luna', 'prompt_sha256', repeat('a', 64), 'evidence_until', now() - interval '1 minute',
  'evidence_rows', 1, 'chunks', 1, 'calls', 1, 'tokens_in', 1234, 'checks', jsonb_build_object('validator', 'ok')) $$;
CREATE FUNCTION pg_temp.hn_cite(p_id uuid, p_excerpt text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_array(jsonb_build_object('table', 'business_events', 'id', p_id::text, 'excerpt', p_excerpt)) $$;
CREATE FUNCTION pg_temp.hn_item(p_ref text, p_type text, p_status text, p_from text, p_what text, p_open jsonb, p_extra jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('ref', p_ref, 'item_type', p_type, 'status', p_status, 'from_role', p_from, 'to_role', 'customer',
  'what', p_what, 'opened_by', p_open) || p_extra $$;
CREATE FUNCTION pg_temp.hn_check(p_job uuid, p_item jsonb) RETURNS text LANGUAGE sql AS $$
 SELECT CASE WHEN (r ->> 'ok')::boolean THEN 'ok' ELSE r ->> 'code' END FROM (SELECT public.context_ledger_check_item(p_job, p_item, 'model') AS r) x $$;
CREATE FUNCTION pg_temp.hn_switch(p_on boolean) RETURNS void LANGUAGE sql AS $$
 UPDATE public.feature_flags SET enabled = p_on WHERE flag_name = 'context_held_notes_v1' $$;
-- One item of the story's ledger read, by key.
CREATE FUNCTION pg_temp.hn_note(p_job uuid, p_gen uuid, p_key text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT x FROM jsonb_array_elements(public.context_job_story_ledger(p_job, p_gen, now()) -> 'items') x WHERE x ->> 'item_key' = p_key $$;

-- 1. Shape.
DO $c$
DECLARE f text;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_held_notes_on()', 'public.context_ledger_held_placed_copy(uuid)',
  'public.context_ledger_held_citable(uuid,uuid,timestamptz)', 'public.context_ledger_held_cite(uuid,jsonb)',
  'public.context_ledger_item_held_now(uuid,jsonb,timestamptz)', 'public.context_job_story_held_marks(jsonb,uuid,timestamptz)',
  'public.context_ledger_check_item(uuid,jsonb,text,uuid,text)', 'public.context_ledger_judge(uuid[])',
  'public.context_job_story_ledger(uuid,uuid,timestamptz)', 'public.context_ledger_packet(uuid,timestamptz,timestamptz)',
  'public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)'] LOOP
  PERFORM pg_temp.hn_assert(to_regprocedure(f) IS NOT NULL, f || ' missing');
  PERFORM pg_temp.hn_assert(has_function_privilege('service_role', f, 'EXECUTE'), f || ' not executable by service_role');
  PERFORM pg_temp.hn_assert(NOT has_function_privilege('anon', f, 'EXECUTE') AND NOT has_function_privilege('authenticated', f, 'EXECUTE'),
   f || ' executable by a browser role');
  -- a new function's comment starts with the slice; a replaced one keeps its slices first and names it after
  PERFORM pg_temp.hn_assert(obj_description(to_regprocedure(f), 'pg_proc') LIKE 'Held notes (20261015100000)%'
   OR (obj_description(to_regprocedure(f), 'pg_proc') NOT LIKE 'Held notes%'
       AND obj_description(to_regprocedure(f), 'pg_proc') LIKE '% Held notes (20261015100000): %'), f || ' comment marker');
 END LOOP;
 PERFORM pg_temp.hn_assert((SELECT bool_and(NOT enabled) AND count(*) = 1 FROM public.feature_flags WHERE flag_name = 'context_held_notes_v1'),
  'the switch exists once and is off');
 PERFORM pg_temp.hn_assert(NOT public.context_held_notes_on(), 'the switch reads off');
 PERFORM pg_temp.hn_assert(EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'context_ledger_items'
   AND column_name = 'job_not_certain' AND is_nullable = 'NO' AND column_default = 'false'), 'job_not_certain column');
 PERFORM pg_temp.hn_assert(EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'context_ledger_items_held_stamp'
   AND tgrelid = 'public.context_ledger_items'::regclass AND NOT tgisinternal), 'the stamp trigger');
END $c$;

-- Fixtures shared by sections 2 and 3: Robin has two fence jobs, A and B.
--  P  a text placed on A ("Can you confirm the gate width please").
--  H  a call transcript held on no job, A and B its candidates: our promise about the crew.
--  H2 a text held on no job, A and B its candidates; a copy of it (C2) sits placed on B.
--  H3 a transcript held on no job whose call row (K3) is placed on B.

-- 2. Off: every replaced function answers byte for byte as the bodies before this migration do.
BEGIN;
\ir fixtures.sql
DO $c$
DECLARE a uuid := '7f000000-0000-4000-8000-0000000000a1'; cl jsonb; res jsonb;
BEGIN
 cl := public.context_ledger_claim(a, 'backfill', (now() AT TIME ZONE 'Australia/Perth')::date);
 PERFORM pg_temp.hn_assert(cl ->> 'outcome' = 'claimed', 'job A is claimed: ' || cl::text);
 res := public.context_ledger_write((cl ->> 'run_id')::uuid, (cl ->> 'lease_token')::uuid, (cl ->> 'generation_id')::uuid, jsonb_build_array(
  pg_temp.hn_item('gate', 'request', 'open', 'customer', 'Robin asked us to confirm the gate width.',
   pg_temp.hn_cite('7fb00000-0000-4000-8000-000000000001', 'confirm the gate width')),
  pg_temp.hn_item('crew', 'commitment', 'open', 'us', 'We promised to tell the crew to add extra concrete at the windy rear.',
   pg_temp.hn_cite('7fb00000-0000-4000-8000-000000000002', 'tell the crew to add extra concrete'))), '[]', 'luna-ledger:v1');
 PERFORM pg_temp.hn_assert(jsonb_array_length(res -> 'accepted') = 1
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(res -> 'refused') x WHERE x ->> 'ref' = 'crew' AND x ->> 'code' = 'citation_off_job'),
  'off: the held promise is refused as off the job, as before: ' || res::text);
 PERFORM pg_temp.hn_assert(NOT EXISTS (SELECT 1 FROM public.context_ledger_items WHERE job_not_certain), 'off: nothing is stamped');
 CREATE TEMP TABLE hn_off AS
  SELECT 'check_placed' AS k, public.context_ledger_check_item(a, pg_temp.hn_item('gate', 'request', 'open', 'customer', 'Robin asked us to confirm the gate width.',
    pg_temp.hn_cite('7fb00000-0000-4000-8000-000000000001', 'confirm the gate width')), 'model') AS v
  UNION ALL SELECT 'check_held', public.context_ledger_check_item(a, pg_temp.hn_item('crew', 'commitment', 'open', 'us', 'We promised the crew.',
    pg_temp.hn_cite('7fb00000-0000-4000-8000-000000000002', 'tell the crew to add extra concrete')), 'model')
  UNION ALL SELECT 'judge', (SELECT jsonb_agg(to_jsonb(j) ORDER BY j.job_id) FROM public.context_ledger_judge(ARRAY[a, '7f000000-0000-4000-8000-0000000000b1'::uuid]) j)
  UNION ALL SELECT 'ledger', public.context_job_story_ledger(a, (cl ->> 'generation_id')::uuid, now())
  UNION ALL SELECT 'packet', public.context_ledger_packet(a, NULL, now())
  UNION ALL SELECT 'packet_update', public.context_ledger_packet(a, '2026-10-01 00:00Z', now())
  UNION ALL SELECT 'story', public.context_job_story(a, now(), (cl ->> 'generation_id')::uuid);
 PERFORM pg_temp.hn_assert((SELECT count(*) FROM hn_off WHERE v IS NOT NULL) = 7, 'seven off answers');
END $c$;
\ir ../../../rollbacks/20261015100000_context_held_notes_down.sql
DO $c$
DECLARE a uuid := '7f000000-0000-4000-8000-0000000000a1'; g uuid; r record; v jsonb;
BEGIN
 SELECT id INTO g FROM public.context_ledger_generations WHERE job_id = a;
 FOR r IN SELECT * FROM hn_off LOOP
  v := CASE r.k
   WHEN 'check_placed' THEN public.context_ledger_check_item(a, pg_temp.hn_item('gate', 'request', 'open', 'customer', 'Robin asked us to confirm the gate width.',
     pg_temp.hn_cite('7fb00000-0000-4000-8000-000000000001', 'confirm the gate width')), 'model')
   WHEN 'check_held' THEN public.context_ledger_check_item(a, pg_temp.hn_item('crew', 'commitment', 'open', 'us', 'We promised the crew.',
     pg_temp.hn_cite('7fb00000-0000-4000-8000-000000000002', 'tell the crew to add extra concrete')), 'model')
   WHEN 'judge' THEN (SELECT jsonb_agg(to_jsonb(j) ORDER BY j.job_id) FROM public.context_ledger_judge(ARRAY[a, '7f000000-0000-4000-8000-0000000000b1'::uuid]) j)
   WHEN 'ledger' THEN public.context_job_story_ledger(a, g, now())
   WHEN 'packet' THEN public.context_ledger_packet(a, NULL, now())
   WHEN 'packet_update' THEN public.context_ledger_packet(a, '2026-10-01 00:00Z', now())
   WHEN 'story' THEN public.context_job_story(a, now(), g) END;
  PERFORM pg_temp.hn_assert(v::text = r.v::text, format('off: %s differs from the earlier body: %s / %s', r.k, left(v::text, 400), left(r.v::text, 400)));
 END LOOP;
END $c$;
ROLLBACK;

-- 3. On: a held-only promise opens a not-certain item on each job it could belong to; placing the
-- message later on one job drops the item on the other and makes it certain on that one.
BEGIN;
\ir fixtures.sql
DO $c$
DECLARE a uuid := '7f000000-0000-4000-8000-0000000000a1'; b uuid := '7f000000-0000-4000-8000-0000000000b1';
 h uuid := '7fb00000-0000-4000-8000-000000000002'; h2 uuid := '7fb00000-0000-4000-8000-000000000003';
 h3 uuid := '7fb00000-0000-4000-8000-000000000005'; p uuid := '7fb00000-0000-4000-8000-000000000001';
 cla jsonb; clb jsonb; res jsonb; chk jsonb; ka text; kb text; n jsonb; pk jsonb; st jsonb; j record; ev_off integer; ev_on integer;
 crew jsonb := pg_temp.hn_cite('7fb00000-0000-4000-8000-000000000002', 'tell the crew to add extra concrete');
BEGIN
 ev_off := (public.context_ledger_packet(a, NULL, now()) ->> 'evidence_rows')::integer;
 PERFORM pg_temp.hn_switch(true);
 PERFORM pg_temp.hn_assert(public.context_held_notes_on(), 'the switch reads on');
 -- held rows are still never evidence: same evidence count, same evidence_until
 ev_on := (public.context_ledger_packet(a, NULL, now()) ->> 'evidence_rows')::integer;
 PERFORM pg_temp.hn_assert(ev_on = ev_off AND ev_on = 1, format('held rows are never evidence rows: %s / %s', ev_off, ev_on));
 PERFORM pg_temp.hn_assert((public.context_ledger_packet(a, NULL, now()) ->> 'evidence_until')::timestamptz = '2026-10-05 01:00Z',
  'held rows never move evidence_until: ' || (public.context_ledger_packet(a, NULL, now()) ->> 'evidence_until'));

 -- the item check: the held promise opens on A and on B, marked job not certain
 chk := public.context_ledger_check_item(a, pg_temp.hn_item('crew', 'commitment', 'open', 'us',
   'We promised to tell the crew to add extra concrete at the windy rear.', crew), 'model');
 PERFORM pg_temp.hn_assert((chk ->> 'ok')::boolean AND chk #>> '{item,job_certain}' = 'false' AND chk #>> '{item,certainty}' = 'job_not_certain'
  AND (chk #>> '{item,opened_at}')::timestamptz = '2026-10-06 02:00Z', 'a held promise opens a not-certain item on job A: ' || chk::text);
 PERFORM pg_temp.hn_assert(pg_temp.hn_check(b, pg_temp.hn_item('crew', 'commitment', 'open', 'us', 'We promised extra concrete.', crew)) = 'ok',
  'and on job B, its other candidate');
 PERFORM pg_temp.hn_assert(pg_temp.hn_check('7f000000-0000-4000-8000-0000000000c1', pg_temp.hn_item('crew', 'commitment', 'open', 'us', 'We promised extra concrete.', crew))
  = 'citation_off_job', 'never on a job that is not its candidate');
 -- open only; never a close; the excerpt rules hold; a placed copy wins; a transcript whose call is placed elsewhere is that job's
 PERFORM pg_temp.hn_assert(pg_temp.hn_check(a, pg_temp.hn_item('crew', 'agreement', 'info', 'us', 'We agreed extra concrete.', crew, '{"modality":"agreed"}'))
  = 'held_not_open', 'a held message opens only an open item');
 PERFORM pg_temp.hn_assert(pg_temp.hn_check(a, pg_temp.hn_item('gate', 'request', 'closed', 'customer', 'Robin asked us to confirm the gate width.',
   pg_temp.hn_cite(p, 'confirm the gate width'), jsonb_build_object('closes_on', 'call', 'closed_by', crew))) = 'citation_off_job',
  'a held message never closes an item');
 PERFORM pg_temp.hn_assert(pg_temp.hn_check(a, pg_temp.hn_item('crew', 'commitment', 'open', 'us', 'We promised extra concrete.',
   pg_temp.hn_cite(h, 'the windy rear corner of the fence and add more concrete'))) = 'excerpt_not_verbatim', 'the excerpt must be verbatim');
 PERFORM pg_temp.hn_assert(pg_temp.hn_check(a, pg_temp.hn_item('post', 'commitment', 'open', 'us', 'We promised to send the photos.',
   pg_temp.hn_cite(h2, 'send the photos tomorrow'))) = 'held_copy_placed', 'a held message with a placed copy is not cited: the copy wins');
 PERFORM pg_temp.hn_assert(public.context_ledger_held_cite(a, pg_temp.hn_cite(h2, 'send the photos tomorrow') -> 0) ->> 'detail' LIKE '%has a copy placed on SWF-970002%',
  'the refusal names where the copy is');
 PERFORM pg_temp.hn_assert(pg_temp.hn_check(a, pg_temp.hn_item('drop', 'commitment', 'open', 'us', 'We promised to drop the gate off.',
   pg_temp.hn_cite(h3, 'drop the spare gate off on Friday'))) = 'held_copy_placed', 'a held transcript whose call is placed on job B is B''s');
 PERFORM pg_temp.hn_assert(pg_temp.hn_check(b, pg_temp.hn_item('drop', 'commitment', 'open', 'us', 'We promised to drop the gate off.',
   pg_temp.hn_cite(h3, 'drop the spare gate off on Friday'))) = 'ok', 'and stays citable on the job its call is on, not certain');

 -- the write: one held message opens one item of a type and matter on a job; a second is a duplicate
 cla := public.context_ledger_claim(a, 'backfill', (now() AT TIME ZONE 'Australia/Perth')::date);
 clb := public.context_ledger_claim(b, 'backfill', (now() AT TIME ZONE 'Australia/Perth')::date);
 PERFORM pg_temp.hn_assert(cla ->> 'outcome' = 'claimed' AND clb ->> 'outcome' = 'claimed', 'both jobs claimed: ' || cla::text || clb::text);
 res := public.context_ledger_write((cla ->> 'run_id')::uuid, (cla ->> 'lease_token')::uuid, (cla ->> 'generation_id')::uuid, jsonb_build_array(
  pg_temp.hn_item('gate', 'request', 'open', 'customer', 'Robin asked us to confirm the gate width.', pg_temp.hn_cite(p, 'confirm the gate width')),
  pg_temp.hn_item('crew', 'commitment', 'open', 'us', 'We promised to tell the crew to add extra concrete at the windy rear.', crew),
  pg_temp.hn_item('crew2', 'commitment', 'open', 'us', 'We said the crew will add more concrete at the rear.', crew)), '[]', 'luna-ledger:v1');
 PERFORM pg_temp.hn_assert(jsonb_array_length(res -> 'accepted') = 2
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(res -> 'refused') x WHERE x ->> 'ref' = 'crew2' AND x ->> 'code' = 'duplicate_item'),
  'job A: the gate request and one crew promise; the same held message never opens a second like item: ' || res::text);
 ka := (SELECT x ->> 'item_key' FROM jsonb_array_elements(res -> 'accepted') x WHERE x ->> 'ref' = 'crew');
 res := public.context_ledger_write((clb ->> 'run_id')::uuid, (clb ->> 'lease_token')::uuid, (clb ->> 'generation_id')::uuid, jsonb_build_array(
  pg_temp.hn_item('crew', 'commitment', 'open', 'us', 'Crew to add extra concrete at the windy rear.', crew)), '[]', 'luna-ledger:v1');
 PERFORM pg_temp.hn_assert(jsonb_array_length(res -> 'accepted') = 1, 'job B: the crew promise too: ' || res::text);
 kb := res -> 'accepted' -> 0 ->> 'item_key';
 -- both readings finish (shadow): the packet's update mode and the judge read the current one
 PERFORM pg_temp.hn_assert(public.context_ledger_finish((cla ->> 'run_id')::uuid, (cla ->> 'lease_token')::uuid, (cla ->> 'generation_id')::uuid,
   'built', pg_temp.hn_meta()) ->> 'outcome' = 'built', 'job A''s reading finishes');
 PERFORM pg_temp.hn_assert(public.context_ledger_finish((clb ->> 'run_id')::uuid, (clb ->> 'lease_token')::uuid, (clb ->> 'generation_id')::uuid,
   'built', pg_temp.hn_meta()) ->> 'outcome' = 'built', 'job B''s reading finishes');
 PERFORM pg_temp.hn_assert(ka = kb, 'the same held message keys the same item on each job: ' || ka || ' / ' || kb);
 PERFORM pg_temp.hn_assert((SELECT bool_and(job_not_certain) AND count(*) = 2 FROM public.context_ledger_items WHERE item_key = ka)
  AND NOT (SELECT job_not_certain FROM public.context_ledger_items WHERE job_id = a AND item_key <> ka),
  'the store stamps the two held items, and only them');

 -- every reader gets the marker: the story's ledger read (the Overview's notes), the packet, the card
 n := pg_temp.hn_note(a, (cla ->> 'generation_id')::uuid, ka);
 PERFORM pg_temp.hn_assert(n ->> 'cites_ok' = 'true' AND n ->> 'job_certain' = 'false' AND n ->> 'certainty' = 'job_not_certain'
  AND n ->> 'what' = 'Job not certain: We promised to tell the crew to add extra concrete at the windy rear.'
  AND n -> 'cited' -> 0 ->> 'held' = 'true', 'the story''s ledger read marks the note: ' || n::text);
 n := (SELECT x FROM jsonb_array_elements(public.context_job_story_ledger(a, (cla ->> 'generation_id')::uuid, now()) -> 'items') x WHERE x ->> 'item_key' <> ka);
 PERFORM pg_temp.hn_assert(NOT n ? 'job_certain' AND n ->> 'what' = 'Robin asked us to confirm the gate width.', 'a placed note is unmarked: ' || n::text);
 pk := public.context_ledger_packet(a, '2026-10-01 00:00Z', now());
 PERFORM pg_temp.hn_assert(EXISTS (SELECT 1 FROM jsonb_array_elements(pk -> 'open_items') x WHERE x ->> 'item_key' = ka AND x ->> 'job_certain' = 'false')
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(pk -> 'open_items') x WHERE x ->> 'item_key' <> ka AND x ? 'job_certain'),
  'the packet''s open items mark the held note only: ' || (pk -> 'open_items')::text);
 PERFORM pg_temp.hn_assert(pk #>> '{held,citable}' = 'job_not_certain'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(pk #> '{held,rows}') x WHERE x ->> 'id' = h::text AND x ->> 'citable' = 'true')
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(pk #> '{held,rows}') x WHERE x ->> 'id' = h2::text AND x ->> 'citable' = 'false'),
  'the packet''s held rows say which may be cited: ' || (pk -> 'held')::text);
 st := public.context_job_story(a, now(), (cla ->> 'generation_id')::uuid);
 PERFORM pg_temp.hn_assert(EXISTS (SELECT 1 FROM jsonb_array_elements(st -> 'loops') x WHERE x ->> 'key' = ka AND x ->> 'job_certain' = 'false'
   AND x ->> 'what' LIKE 'Job not certain: %') AND (st #>> '{meta,ledger,job_not_certain_items}')::int = 1,
  'the job card marks the loop: ' || (st -> 'loops')::text);
 -- the judge: a not-certain note's held citation has not moved
 SELECT * INTO j FROM public.context_ledger_judge(ARRAY[a]);
 PERFORM pg_temp.hn_assert(j.reason IS DISTINCT FROM 'citation_moved', 'job A is not a moved citation while the message is held: ' || to_jsonb(j)::text);

 -- later placement: the message is placed on job B. On B the note reads as certain; on A it is
 -- dropped: hidden now, and the judge rebuilds A without it.
 PERFORM pg_temp.hn_place(h, b);
 n := pg_temp.hn_note(b, (clb ->> 'generation_id')::uuid, kb);
 PERFORM pg_temp.hn_assert(n ->> 'cites_ok' = 'true' AND NOT n ? 'job_certain' AND n ->> 'what' = 'Crew to add extra concrete at the windy rear.',
  'placed on B: B''s note is certain: ' || n::text);
 n := pg_temp.hn_note(a, (cla ->> 'generation_id')::uuid, ka);
 PERFORM pg_temp.hn_assert(n ->> 'cites_ok' = 'false' AND NOT n ? 'job_certain', 'placed on B: A''s note is hidden: ' || n::text);
 SELECT * INTO j FROM public.context_ledger_judge(ARRAY[a]);
 PERFORM pg_temp.hn_assert(j.reason = 'citation_moved', 'placed on B: job A is due a rebuild for the moved citation: ' || to_jsonb(j)::text);
 SELECT * INTO j FROM public.context_ledger_judge(ARRAY[b]);
 PERFORM pg_temp.hn_assert(j.reason IS DISTINCT FROM 'citation_moved', 'placed on B: job B is not: ' || to_jsonb(j)::text);
 PERFORM pg_temp.hn_assert(pg_temp.hn_check(a, pg_temp.hn_item('crew', 'commitment', 'open', 'us', 'We promised extra concrete.', crew)) = 'citation_off_job',
  'placed on B: a rebuild of A cannot write it again');
 st := public.context_job_story(a, now(), (cla ->> 'generation_id')::uuid);
 PERFORM pg_temp.hn_assert(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(st -> 'loops') x WHERE x ->> 'key' = ka)
  AND NOT (st #> '{meta,ledger}') ? 'job_not_certain_items', 'placed on B: A''s card no longer shows it');

 -- switched off again: a held note left in the store is hidden, never shown as certain
 PERFORM pg_temp.hn_hold(h);
 PERFORM pg_temp.hn_assert(pg_temp.hn_note(a, (cla ->> 'generation_id')::uuid, ka) ->> 'job_certain' = 'false', 'held again: A''s note is back, not certain');
 PERFORM pg_temp.hn_switch(false);
 n := pg_temp.hn_note(a, (cla ->> 'generation_id')::uuid, ka);
 PERFORM pg_temp.hn_assert(n ->> 'cites_ok' = 'false' AND NOT n ? 'job_certain', 'switched off: the note is hidden: ' || n::text);
 SELECT * INTO j FROM public.context_ledger_judge(ARRAY[a]);
 PERFORM pg_temp.hn_assert(j.reason = 'citation_moved', 'switched off: the judge rebuilds the job without it: ' || to_jsonb(j)::text);
END $c$;
ROLLBACK;

-- 4. Re-applying the migration changes nothing (its guard accepts its own bodies).
BEGIN;
-- (person review, 20261018120000) replaced the item check, the write, the assembler and the
-- story's ledger read since: its down goes first, inside this transaction only, while those
-- bodies are still its own (a later down of the item check would no longer match its guard).
SELECT coalesce(obj_description(to_regprocedure('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)'), 'pg_proc'), '')
       LIKE '%(person review, 20261018120000)%' AS person_review_live \gset
\if :person_review_live
\ir ../../../rollbacks/20261019120000_context_ledger_person_review_down.sql
\endif
CREATE TEMP TABLE hn_md5 AS
 SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS m, obj_description(p.oid, 'pg_proc') AS c, p.proacl::text AS acl FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('context_held_notes_on', 'context_ledger_held_placed_copy',
  'context_ledger_held_citable', 'context_ledger_held_cite', 'context_ledger_item_held_now', 'context_job_story_held_marks',
  'context_ledger_items_held_stamp', 'context_ledger_check_item', 'context_ledger_judge', 'context_job_story_ledger', 'context_ledger_packet',
  'context_job_story');
\ir ../../../migrations/20261015100000_context_held_notes.sql
DO $c$ BEGIN
 PERFORM pg_temp.hn_assert((SELECT count(*) FROM hn_md5) = 12, 'twelve functions before the re-apply');
 PERFORM pg_temp.hn_assert(NOT EXISTS (SELECT 1 FROM hn_md5 b LEFT JOIN pg_proc p ON p.oid = to_regprocedure(b.sig)
   WHERE p.oid IS NULL OR md5(p.prosrc) <> b.m OR obj_description(p.oid, 'pg_proc') IS DISTINCT FROM b.c OR p.proacl::text IS DISTINCT FROM b.acl),
  're-applying changed a body, comment or grant');
 PERFORM pg_temp.hn_assert((SELECT count(*) FROM public.feature_flags WHERE flag_name = 'context_held_notes_v1') = 1, 'one switch row');
END $c$;
ROLLBACK;
