-- Card speed contract: the story meta's old-inbox copy count (mail_copy_elsewhere) is the same as the
-- earlier body's, mail by mail: a copy found by the source pointer, by the graph key, by the payload
-- key, or recorded with no recorded_at by its occurred_at counts; no copy, a copy recorded after the
-- instant, or a payload naming the mail only inside an array does not. Then the whole meta answer is
-- compared with the earlier body's, read in the same transaction after this change's down. Fixed
-- instant: Wed 7 Oct 2026 10:00 Perth. Invented rows, rolled back.
BEGIN;
SET LOCAL session_replication_role = replica;

INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, client_email, ghl_contact_id, xero_contact_id, pricing_json,
  accepted_at, completed_at, created_at)
VALUES
 ('41600000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000aa', 'SWF-T6001', 'quoted', 'fencing', 'Speed Client',
  'speed.c@example.test', 'ct416a', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z'),
 ('41600000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000aa', 'SWF-T6002', 'archived', 'fencing', 'Speed Bucket',
  NULL, NULL, NULL, '{}', NULL, NULL, '2026-08-01 01:00Z'),
 ('41600000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000aa', 'SWF-T6003', 'quoted', 'fencing', 'Quiet Client',
  'quiet.c@example.test', 'ct416q', NULL, '{}', NULL, NULL, '2026-09-01 01:00Z');
UPDATE public.jobs SET updated_at = '2026-08-01 01:00Z' WHERE id = '41600000-0000-4000-8000-000000000002';

-- Seven old-inbox mails on the live job, one per instant.
INSERT INTO public.inbox_events (id, job_id, from_email, subject, body_preview, received_at, processed_at, graph_message_id, mailbox, classification)
VALUES
 ('41a00000-0000-4000-8000-000000000001', '41600000-0000-4000-8000-000000000001', 'speed.c@example.test', 'One', 'Pointer copy',
  '2026-09-20 01:00Z', '2026-09-20 01:00Z', 'g416-1', 'office@example.test', 'client_reply'),
 ('41a00000-0000-4000-8000-000000000002', '41600000-0000-4000-8000-000000000001', 'speed.c@example.test', 'Two', 'Graph copy',
  '2026-09-21 01:00Z', '2026-09-21 01:00Z', 'g416-2', 'office@example.test', 'client_reply'),
 ('41a00000-0000-4000-8000-000000000003', '41600000-0000-4000-8000-000000000001', 'speed.c@example.test', 'Three', 'Payload copy',
  '2026-09-22 01:00Z', '2026-09-22 01:00Z', 'g416-3', 'office@example.test', 'client_reply'),
 ('41a00000-0000-4000-8000-000000000004', '41600000-0000-4000-8000-000000000001', 'speed.c@example.test', 'Four', 'No copy',
  '2026-09-23 01:00Z', '2026-09-23 01:00Z', 'g416-4', 'office@example.test', 'client_reply'),
 ('41a00000-0000-4000-8000-000000000005', '41600000-0000-4000-8000-000000000001', 'speed.c@example.test', 'Five', 'Copy after the instant',
  '2026-09-24 01:00Z', '2026-09-24 01:00Z', 'g416-5', 'office@example.test', 'client_reply'),
 ('41a00000-0000-4000-8000-000000000006', '41600000-0000-4000-8000-000000000001', 'speed.c@example.test', 'Six', 'Id inside an array',
  '2026-09-25 01:00Z', '2026-09-25 01:00Z', 'g416-6', 'office@example.test', 'client_reply'),
 ('41a00000-0000-4000-8000-000000000007', '41600000-0000-4000-8000-000000000001', 'speed.c@example.test', 'Seven', 'Graph copy, no recorded_at',
  '2026-09-26 01:00Z', '2026-09-26 01:00Z', NULL, 'office@example.test', 'client_reply');
UPDATE public.inbox_events SET graph_message_id = 'g416-7' WHERE id = '41a00000-0000-4000-8000-000000000007';

INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_confidence, source_table, source_id, provider_message_id)
VALUES
 -- 1: by the source pointer, on the archived bucket job
 ('41b00000-0000-4000-8000-000000000001', '41600000-0000-4000-8000-000000000002', 'client.email_in', 'monitor-inbox', 'email', 'inbound', NULL,
  '{"body":"Pointer copy","from":"speed.c@example.test","subject":"One"}', '{"written_as":"service_role"}',
  '2026-09-20 01:00Z', '2026-09-20 01:05Z', '2026-09-20 01:00Z', '2026-09-20 01:05Z', 'direct', 1, 'inbox_events', '41a00000-0000-4000-8000-000000000001', NULL),
 -- 2: by the graph key, on no job
 ('41b00000-0000-4000-8000-000000000002', NULL, 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', NULL,
  '{"body":"Graph copy","from":"speed.c@example.test","subject":"Two"}', '{"written_as":"service_role"}',
  '2026-09-21 01:00Z', '2026-09-21 01:05Z', '2026-09-21 01:00Z', '2026-09-21 01:05Z', 'unplaced', NULL, NULL, NULL, 'graph:g416-2'),
 -- 3: by the payload key (an old-path copy), on no job
 ('41b00000-0000-4000-8000-000000000003', NULL, 'client.email_in', 'monitor_inbox', NULL, NULL, NULL,
  '{"body":"Payload copy","inbox_events_id":"41a00000-0000-4000-8000-000000000003"}', '{"written_as":"service_role"}',
  '2026-09-22 01:00Z', '2026-09-22 01:01Z', NULL, '2026-09-22 01:01Z', 'unplaced', NULL, NULL, NULL, NULL),
 -- 5: by the payload key, but recorded after the instant
 ('41b00000-0000-4000-8000-000000000005', NULL, 'client.email_in', 'monitor_inbox', NULL, NULL, NULL,
  '{"body":"Copy after the instant","inbox_events_id":"41a00000-0000-4000-8000-000000000005"}', '{"written_as":"service_role"}',
  '2026-10-08 01:00Z', '2026-10-08 01:01Z', NULL, '2026-10-08 01:01Z', 'unplaced', NULL, NULL, NULL, NULL),
 -- 6: the id only inside an array, which containment never matches
 ('41b00000-0000-4000-8000-000000000006', NULL, 'client.email_in', 'monitor_inbox', NULL, NULL, NULL,
  '{"body":"Id inside an array","inbox_events_id":["41a00000-0000-4000-8000-000000000006"]}', '{"written_as":"service_role"}',
  '2026-09-25 01:00Z', '2026-09-25 01:01Z', NULL, '2026-09-25 01:01Z', 'unplaced', NULL, NULL, NULL, NULL),
 -- 7: by the graph key, no recorded_at, occurred before the instant
 ('41b00000-0000-4000-8000-000000000007', NULL, 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', NULL,
  '{"body":"Graph copy, no recorded_at","from":"speed.c@example.test","subject":"Seven"}', '{"written_as":"service_role"}',
  '2026-09-26 01:00Z', NULL, '2026-09-26 01:00Z', '2026-09-26 01:05Z', 'unplaced', NULL, NULL, NULL, 'graph:g416-7');

CREATE TEMP TABLE card_speed_new ON COMMIT DROP AS
SELECT j.id, public.context_job_story_meta(j.id, '2026-10-07 02:00Z') AS meta
FROM public.jobs j WHERE j.id IN ('41600000-0000-4000-8000-000000000001', '41600000-0000-4000-8000-000000000002',
                                  '41600000-0000-4000-8000-000000000003');

DO $c$
DECLARE
 n int;
 fn text;
BEGIN
 SELECT (meta -> 'mail_copy_elsewhere' ->> 'count')::int INTO n FROM card_speed_new WHERE id = '41600000-0000-4000-8000-000000000001';
 IF n IS DISTINCT FROM 4 THEN
  RAISE EXCEPTION 'card speed contract: four mails have a copy by the instant (pointer, graph, payload, graph with no recorded_at), got %', n;
 END IF;
 SELECT (meta -> 'mail_copy_elsewhere' ->> 'count')::int INTO n FROM card_speed_new WHERE id = '41600000-0000-4000-8000-000000000003';
 IF n IS DISTINCT FROM 0 THEN
  RAISE EXCEPTION 'card speed contract: a job with no old-inbox mail counts no copy, got %', n;
 END IF;
 SELECT md5(prosrc) INTO fn FROM pg_proc WHERE oid = 'public.context_job_story_meta(uuid,timestamptz)'::regprocedure;
 IF fn IS DISTINCT FROM '1fd862135f975c55e153fd44a83b4fad' THEN
  RAISE EXCEPTION 'card speed contract: the story meta must be this change''s body, got %', fn;
 END IF;
 -- the copy test is one test over the three keys, never three ORed tests
 IF position($p$c.payload ? 'inbox_events_id' AND (c.payload ->> 'inbox_events_id') = m.id::text$p$ IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.context_job_story_meta(uuid,timestamptz)'::regprocedure)) = 0 THEN
  RAISE EXCEPTION 'card speed contract: the copy test must read the three copy keys as one test';
 END IF;
 -- the payload key's own index answers the payload read
 IF to_regclass('public.business_events_inbox_events_id_any_source') IS NULL THEN
  RAISE EXCEPTION 'card speed contract: the payload key index must exist';
 END IF;
END $c$;

-- The earlier body, in this transaction only, must give the same whole answer for every job.
\ir ../../../rollbacks/20261116090000_context_story_card_speed_down.sql

DO $c$
DECLARE
 r record;
 fn text;
BEGIN
 SELECT md5(prosrc) INTO fn FROM pg_proc WHERE oid = 'public.context_job_story_meta(uuid,timestamptz)'::regprocedure;
 IF fn IS DISTINCT FROM '636e3aa055351f73d4747f610447cd63' THEN
  RAISE EXCEPTION 'card speed contract: the down must restore the earlier body, got %', fn;
 END IF;
 FOR r IN SELECT n.id, n.meta AS new_meta, public.context_job_story_meta(n.id, '2026-10-07 02:00Z') AS old_meta FROM card_speed_new n LOOP
  IF r.new_meta IS DISTINCT FROM r.old_meta THEN
   RAISE EXCEPTION 'card speed contract: job % reads differently from the earlier body: % / %', r.id, r.new_meta, r.old_meta;
  END IF;
 END LOOP;
END $c$;
ROLLBACK;
