-- Runs after supabase/rollbacks/20261012100000_context_held_messages_down.sql on the stack applied
-- through this case: 20261007150000's packet and 20261011120000's story read are back, bodies and
-- comments word for word, with the same access; the two helpers are gone; the packet has no held
-- section and the story no held_messages again.
DO $restored$
DECLARE x record; live text; p jsonb; s jsonb;
BEGIN
 FOR x IN SELECT * FROM (VALUES
   ('public.context_ledger_packet(uuid,timestamptz,timestamptz)', '423469bdff01ae4029c155f6c73c078d',
    'Context ledger store (20261006013000), ledger reader fixes (20261007150000): still ledger-packet-v1, with fields added:%'),
   ('public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)', '909e3212b3d58c71d5b96f0db449d735',
    'Job story (20261006014000), lead cutoff (20261007010000): (story settled notes, 20261011120000) meta also carries%')) v(sig, m, cmt) LOOP
  SELECT md5(pr.prosrc) INTO live FROM pg_proc pr WHERE pr.oid = to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.m THEN
   RAISE EXCEPTION 'held messages rollback: % md5 % (want %)', x.sig, coalesce(live, '<missing>'), x.m;
  END IF;
  IF coalesce(obj_description(to_regprocedure(x.sig), 'pg_proc'), '') LIKE '%(held messages%'
     OR coalesce(obj_description(to_regprocedure(x.sig), 'pg_proc'), '') NOT LIKE x.cmt THEN
   RAISE EXCEPTION 'held messages rollback: the % comment is not the earlier one', x.sig;
  END IF;
  IF has_function_privilege('anon', x.sig, 'EXECUTE') OR has_function_privilege('authenticated', x.sig, 'EXECUTE')
     OR NOT has_function_privilege('service_role', x.sig, 'EXECUTE') THEN
   RAISE EXCEPTION 'held messages rollback: % access wrong', x.sig;
  END IF;
 END LOOP;
 IF to_regprocedure('public.context_ledger_held_rows(uuid[],timestamptz)') IS NOT NULL
    OR to_regprocedure('public.context_job_story_held(uuid,timestamptz)') IS NOT NULL THEN
  RAISE EXCEPTION 'held messages rollback: a helper is still there';
 END IF;
END $restored$;

-- The restored bodies answer, with no held section: a job with a message held on no job.
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, ghl_contact_id, pricing_json, created_at, updated_at)
VALUES ('72000000-0000-4000-8000-000000261469', '00000000-0000-4000-8000-0000000000aa', 'SWF-961469', 'in_progress', 'fencing', 'Held HM', 'ct-hm-a', '{}',
        '2026-09-22 00:00Z', '2026-09-22 00:00Z'),
       ('72000000-0000-4000-8000-000000261470', '00000000-0000-4000-8000-0000000000aa', 'SWF-961470', 'quoted', 'fencing', 'Held HM', 'ct-hm-a', '{}',
        '2026-10-01 00:00Z', '2026-10-01 00:00Z');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata,
  occurred_at, recorded_at, event_at, context_captured_at, attribution_status, candidate_job_ids)
VALUES ('72b00000-0000-4000-8000-000000000002', NULL, 'client.sms_in', 'ghl', 'sms', 'inbound', 'ct-hm-a',
  '{"body":"When are you coming back to finish?"}', '{"written_as":"service_role","placement_rule":"review_several"}',
  '2026-10-09 02:00Z', '2026-10-09 02:00Z', '2026-10-09 02:00Z', '2026-10-09 02:00Z', 'unplaced',
  ARRAY['72000000-0000-4000-8000-000000261469', '72000000-0000-4000-8000-000000261470']::uuid[]);
DO $read$
DECLARE p jsonb; s jsonb;
BEGIN
 p := public.context_ledger_packet('72000000-0000-4000-8000-000000261469', NULL, '2026-10-11T04:00:00Z');
 s := public.context_job_story('72000000-0000-4000-8000-000000261469', '2026-10-11T04:00:00Z');
 IF p ? 'held' OR p->>'version' IS DISTINCT FROM 'ledger-packet-v1' OR s ? 'held_messages' OR s->>'version' IS DISTINCT FROM 'job-story-v1' THEN
  RAISE EXCEPTION 'held messages rollback: the earlier packet has no held section and the earlier story no held_messages';
 END IF;
END $read$;
ROLLBACK;
