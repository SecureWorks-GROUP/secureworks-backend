-- Rollback contract: 20261009131000_context_group_mailbox_audience (group mailbox audience). The runner
-- applied the stack through this migration and then its down: the four functions are gone. Over stored
-- rows, the migration re-applied on top of its own rollback relabels and confirms them, and the
-- resolver relabels a row the new reader saved; the down then puts every relabelled row back exactly as
-- it was (label, counterpart, To, Cc and captured time, no basis, no relabel record), gives the rows the
-- new reader saved under the rule the old rule's internal label, takes a confirmed basis off, and drops
-- the functions; the party-roles trigger re-stamps each. The down runs again cleanly.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.rb_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'group mailbox audience rollback contract: %', p_msg; END IF; END $$;
CREATE FUNCTION pg_temp.rb_id(p_n integer) RETURNS uuid LANGUAGE sql AS $$
 SELECT ('9a0d1e02-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.rb_payload(p_mailbox text, p_folder text, p_subject text, p_email text DEFAULT NULL,
 p_basis text DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('body', 'Subject: ' || p_subject || E'\n\nWords.', 'subject', p_subject, 'email', p_email,
  'from', 'admin@secureworkswa.com.au', 'to', '[]'::jsonb, 'cc', '[]'::jsonb, 'mailbox', p_mailbox, 'folder_kind', p_folder,
  'sender_kind', 'ours', 'sent_by_kind', 'staff_email', 'sent_by_user', 'admin@secureworkswa.com.au')
  || CASE WHEN p_basis IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('audience_basis', p_basis) END $$;
-- A stored row of our own email, written straight in (no trigger), on no job.
CREATE FUNCTION pg_temp.rb_ev(p_n integer, p_type text, p_direction text, p_payload jsonb, p_at timestamptz) RETURNS uuid
LANGUAGE plpgsql SET session_replication_role = replica AS $$
BEGIN
 INSERT INTO public.business_events (id, event_type, source, channel, direction, payload, metadata, provider_message_id,
  occurred_at, event_at, recorded_at, context_captured_at, match_method)
 VALUES (pg_temp.rb_id(p_n), p_type, 'outlook-mail-capture', 'email', p_direction, p_payload,
  '{"written_as": "service_role", "capture_mode": "backfill", "capture_path": "outlook_mail_v1"}'::jsonb,
  'email:rb-' || p_n || '@secureworkswa.com.au', p_at + interval '1 hour', p_at, p_at + interval '1 hour', p_at + interval '1 hour', 'none');
 RETURN pg_temp.rb_id(p_n);
END $$;

DO $c$
BEGIN
 PERFORM pg_temp.rb_assert(NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('context_email_audience_topic', 'context_email_audience_plan', 'context_email_audience_backfill',
    'context_email_audience_resolve')), 'the down left a function behind');
END $c$;

BEGIN;
CREATE TEMP TABLE rb_before ON COMMIT DROP AS SELECT NULL::uuid AS id, NULL::jsonb AS v LIMIT 0;
DO $c$
BEGIN
 -- Saved internal before the rule: a post with an old-inbox copy to an outside address, a post with
 -- nothing (unknown), a forward whose copy names only our group (confirmed internal).
 PERFORM pg_temp.rb_ev(1, 'staff.email_internal', 'internal', pg_temp.rb_payload('ses@secureworkswa.com.au', 'group', 'Our Ref: BLD-99031'),
  '2026-09-01 01:00Z');
 INSERT INTO public.inbox_events (id, job_id, metadata, received_at, processed_at, graph_message_id, mailbox, subject, body_preview,
  from_email, from_name, to_email, classification)
 VALUES ('9a0d1e03-0000-4000-8000-000000000001', NULL, '{}', '2026-09-01 01:00Z', '2026-09-01 01:00Z', 'g-rb-1',
  'marnin@secureworkswa.com.au', 'RE: Our Ref: BLD-99031', 'Words.', 'admin@secureworkswa.com.au', 'Admin',
  'ses@secureworkswa.com.au, coordinator@builder.example', 'client_reply'),
  ('9a0d1e03-0000-4000-8000-000000000003', NULL, '{}', '2026-09-03 01:00Z', '2026-09-03 01:00Z', 'g-rb-3',
  'marnin@secureworkswa.com.au', 'Fw: Our Ref: BLD-99033', 'Words.', 'admin@secureworkswa.com.au', 'Admin',
  'ses@secureworkswa.com.au', 'client_reply');
 PERFORM pg_temp.rb_ev(2, 'staff.email_internal', 'internal', pg_temp.rb_payload('finance@secureworkswa.com.au', 'group', 'BLD-99032 - Xero invoice'),
  '2026-09-02 01:00Z');
 PERFORM pg_temp.rb_ev(3, 'staff.email_internal', 'internal', pg_temp.rb_payload('ses@secureworkswa.com.au', 'group', 'Our Ref: BLD-99033'),
  '2026-09-03 01:00Z');
 -- Saved by the new reader under the rule: from its thread, and unknown.
 PERFORM pg_temp.rb_ev(4, 'client.email_out', 'outbound',
  pg_temp.rb_payload('ses@secureworkswa.com.au', 'group', 'Our Ref: BLD-99034', 'coordinator@builder.example', 'group_thread'),
  '2026-09-04 01:00Z');
 PERFORM pg_temp.rb_ev(5, 'staff.email_unknown_audience', 'outbound',
  pg_temp.rb_payload('finance@secureworkswa.com.au', 'group', 'BLD-99035 - Xero invoice', NULL, 'unknown'), '2026-09-05 01:00Z');
 -- Saved by the new reader from its thread; its mailbox copy (sent to the group only) will relabel it.
 PERFORM pg_temp.rb_ev(6, 'client.email_out', 'outbound',
  pg_temp.rb_payload('ses@secureworkswa.com.au', 'group', 'Our Ref: BLD-99036', 'coordinator@builder.example', 'group_thread'),
  '2026-09-06 01:00Z');
END $c$;
INSERT INTO rb_before SELECT b.id, to_jsonb(b) - 'sequence_number' FROM public.business_events b
 WHERE b.id IN (SELECT pg_temp.rb_id(n) FROM generate_series(1, 6) n);
\ir ../../../migrations/20261009131000_context_group_mailbox_audience.sql
DO $c$
DECLARE out jsonb;
BEGIN
 PERFORM pg_temp.rb_assert((SELECT b.event_type = 'client.email_out' AND b.payload ->> 'audience_basis' = 'inbox_copy'
   AND b.context_captured_at > '2026-09-30 00:00Z' FROM public.business_events b WHERE b.id = pg_temp.rb_id(1)), 'the forward relabel of 1');
 PERFORM pg_temp.rb_assert((SELECT b.event_type = 'staff.email_unknown_audience' FROM public.business_events b WHERE b.id = pg_temp.rb_id(2)),
  'the forward relabel of 2');
 PERFORM pg_temp.rb_assert((SELECT b.event_type = 'staff.email_internal' AND b.payload ->> 'audience_basis' = 'inbox_copy'
   FROM public.business_events b WHERE b.id = pg_temp.rb_id(3)), 'the forward confirmation of 3');
 UPDATE public.automation_switches SET capture = true, all_stop = false WHERE id = 1;
 out := public.context_email_audience_resolve(jsonb_build_object('provider_message_id', 'email:rb-6@secureworkswa.com.au',
  'source', 'outlook-mail-capture', 'channel', 'email', 'event_type', 'staff.email_internal', 'direction', 'internal',
  'payload', jsonb_build_object('email', NULL::text, 'to', '["ses@secureworkswa.com.au"]'::jsonb, 'cc', '[]'::jsonb,
   'mailbox', 'admin@secureworkswa.com.au', 'folder_kind', 'sent', 'sender_kind', 'ours')));
 PERFORM pg_temp.rb_assert(out ->> 'outcome' = 'relabelled', 'the resolver relabels 6: ' || out::text);
END $c$;
\ir ../../../rollbacks/20261009131000_context_group_mailbox_audience_down.sql
DO $c$
DECLARE b public.business_events; x jsonb;
BEGIN
 -- Relabelled before the down: back exactly as stored (party-roles stamp aside: the down re-stamps).
 FOR b IN SELECT * FROM public.business_events WHERE id IN (pg_temp.rb_id(1), pg_temp.rb_id(2), pg_temp.rb_id(3)) LOOP
  SELECT v INTO x FROM rb_before WHERE id = b.id;
  PERFORM pg_temp.rb_assert((to_jsonb(b) - 'sequence_number' - 'metadata') = (x - 'metadata')
   AND (b.metadata - 'party_roles') = (x -> 'metadata'), b.id::text || ' is not back as stored: ' || (to_jsonb(b) - 'sequence_number')::text);
  PERFORM pg_temp.rb_assert(b.metadata #>> '{party_roles,audience}' = 'internal', b.id::text || ' is re-stamped internal');
 END LOOP;
 -- Saved by the new reader under the rule (4, 5) or relabelled by the resolver from such a row (6): the old rule's label.
 FOR b IN SELECT * FROM public.business_events WHERE id IN (pg_temp.rb_id(4), pg_temp.rb_id(5), pg_temp.rb_id(6)) LOOP
  SELECT v INTO x FROM rb_before WHERE id = b.id;
  PERFORM pg_temp.rb_assert(b.event_type = 'staff.email_internal' AND b.direction = 'internal' AND b.payload -> 'email' = 'null'::jsonb
   AND NOT b.payload ? 'audience_basis' AND NOT b.payload ? 'recipients_from' AND NOT b.metadata ? 'audience_relabel'
   AND b.payload -> 'to' = '[]'::jsonb AND b.payload -> 'cc' = '[]'::jsonb AND b.context_captured_at = (x ->> 'context_captured_at')::timestamptz
   AND (b.payload - 'email') = ((x -> 'payload') - 'email' - 'audience_basis'), b.id::text || ' does not carry the old rule''s label: '
   || (to_jsonb(b) - 'sequence_number')::text);
 END LOOP;
 PERFORM pg_temp.rb_assert(NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname LIKE 'context\_email\_audience\_%'), 'the down dropped the functions');
END $c$;
\ir ../../../rollbacks/20261009131000_context_group_mailbox_audience_down.sql
ROLLBACK;
