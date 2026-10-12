-- Contract: 20261009131000_context_group_mailbox_audience (group mailbox audience, 9 Oct 2026). Every
-- fixture write is rolled back. Addresses, job numbers, ids and words are synthetic. Stored rows are
-- written straight in (session_replication_role replica) so each states exactly what the email reader
-- saved; the relabels then run as production runs them, the party-roles trigger included. The rows
-- between the ROWS markers are exactly what the TypeScript builder (_shared/evidence/outlook_mail.ts)
-- produces for the synthetic fixtures in outlook_mail_fixtures.ts;
-- outlook_mail_audience_contract_rows_test.ts fails if they drift.
--
--  1. Shape: the four functions, their markers, grants, security and path; the topic.
--  2. The reader's resolver: a copy of our own email meeting the row another copy saved relabels it
--     only on a stronger basis and a different label (the landed time moves, the first original is
--     kept), confirms a same label on a stronger basis, and is unchanged otherwise; refusals, the lane,
--     a missing row, someone else's row.
--  3. The plan and the relabel over stored rows: the old inbox's copy first (an outside To, or only
--     ours: confirmed internal, never moved by its thread), then the thread (newest outside sender at
--     or before, else the earliest after; a mailbox row never reads one), else unknown; the dry run
--     writes nothing; the relabel moves each relabelled row's landed time, keeps its original and is
--     re-stamped (never internal); a second relabel writes nothing; and the ledger judge, which read
--     every row before, finds the jobs due (late_evidence, a rebuild; new_evidence, an update).
--  4. The migration applied again over stored rows relabels them, changes no body, comment or grant,
--     and a further apply writes nothing.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.ga_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'group mailbox audience contract: %', p_msg; END IF; END $$;
CREATE FUNCTION pg_temp.ga_id(p_n integer) RETURNS uuid LANGUAGE sql AS $$
 SELECT ('9a0d1e00-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.ga_iid(p_n integer) RETURNS uuid LANGUAGE sql AS $$
 SELECT ('9a0d1e01-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid $$;
-- A job created long before its fixture mail.
CREATE FUNCTION pg_temp.ga_job(p_n integer, p_number text) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, client_email, ghl_contact_id, site_suburb, metadata, created_at)
 VALUES (pg_temp.ga_id(900 + p_n), '00000000-0000-0000-0000-000000000001', 'scheduled', 'fencing', p_number, 'Pat Example', NULL, NULL,
  'Testville', '{}', '2026-08-01 00:00Z');
 RETURN pg_temp.ga_id(900 + p_n);
END $$;
-- What the email reader saved for one email (the fields the rule reads, in outlook_mail.ts's shape).
CREATE FUNCTION pg_temp.ga_payload(p_mailbox text, p_folder text, p_from text, p_subject text, p_words text,
 p_email text DEFAULT NULL, p_to jsonb DEFAULT '[]', p_cc jsonb DEFAULT '[]', p_kind text DEFAULT 'ours') RETURNS jsonb
LANGUAGE sql AS $$
 SELECT jsonb_build_object('body', 'Subject: ' || p_subject || E'\n\n' || p_words, 'subject', p_subject, 'email', p_email,
  'from', p_from, 'to', p_to, 'cc', p_cc, 'mailbox', p_mailbox, 'folder_kind', p_folder, 'sender_kind', p_kind,
  'sent_by_kind', CASE WHEN p_kind = 'ours' THEN 'staff_email' ELSE 'external' END,
  'sent_by_user', CASE WHEN p_kind = 'ours' THEN p_from END) $$;
-- One stored row, written straight in (no trigger), on p_job when given, landed an hour after it was sent.
CREATE FUNCTION pg_temp.ga_ev(p_n integer, p_job uuid, p_type text, p_direction text, p_payload jsonb, p_at timestamptz,
 p_source text DEFAULT 'outlook-mail-capture') RETURNS uuid
LANGUAGE plpgsql SET session_replication_role = replica AS $$
BEGIN
 INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, payload, metadata, provider_message_id,
  occurred_at, event_at, recorded_at, context_captured_at, attribution_status, attribution_step, attribution_confidence,
  attributed_at, match_method)
 VALUES (pg_temp.ga_id(p_n), p_job, p_type, p_source, 'email', p_direction, p_payload,
  '{"written_as": "service_role", "capture_mode": "backfill", "capture_path": "outlook_mail_v1"}'::jsonb,
  'email:ga-' || p_n || '@mail.example.com', p_at + interval '1 hour', p_at, p_at + interval '1 hour', p_at + interval '1 hour',
  CASE WHEN p_job IS NULL THEN 'unplaced' ELSE 'direct' END, CASE WHEN p_job IS NULL THEN NULL ELSE 1 END,
  CASE WHEN p_job IS NULL THEN NULL ELSE 1 END, CASE WHEN p_job IS NULL THEN NULL ELSE p_at + interval '1 hour' END,
  CASE WHEN p_job IS NULL THEN 'none' ELSE 'direct_job_id' END);
 RETURN pg_temp.ga_id(p_n);
END $$;
-- The old poller's copy of an email in a member's inbox: its To line, placed on no job.
CREATE FUNCTION pg_temp.ga_inbox(p_n integer, p_from text, p_at timestamptz, p_subject text, p_to text) RETURNS uuid
LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO public.inbox_events (id, job_id, metadata, received_at, processed_at, graph_message_id, mailbox, subject, body_preview,
  from_email, from_name, to_email, classification)
 VALUES (pg_temp.ga_iid(p_n), NULL, '{}', p_at, p_at, 'g-ga-' || p_n, 'marnin@secureworkswa.com.au', p_subject, 'Words.', p_from,
  'Sender Name', p_to, 'client_reply');
 RETURN pg_temp.ga_iid(p_n);
END $$;
-- A builder row stored as the reader saved it (no trigger).
CREATE FUNCTION pg_temp.ga_store(p_row jsonb) RETURNS uuid LANGUAGE plpgsql SET session_replication_role = replica AS $$
DECLARE v uuid := gen_random_uuid();
BEGIN
 INSERT INTO public.business_events (id, event_type, source, entity_type, entity_id, channel, direction, provider_message_id,
  payload, metadata, occurred_at, event_at, recorded_at, context_captured_at, match_method)
 VALUES (v, p_row ->> 'event_type', p_row ->> 'source', p_row ->> 'entity_type', p_row ->> 'entity_id', p_row ->> 'channel',
  p_row ->> 'direction', p_row ->> 'provider_message_id', p_row -> 'payload',
  (p_row -> 'metadata') || '{"written_as": "service_role"}'::jsonb, '2026-10-01 05:00Z', (p_row ->> 'event_at')::timestamptz,
  '2026-10-01 05:00Z', '2026-10-01 05:00Z', 'none');
 RETURN v;
END $$;
-- What the reader saved for a copy before this rule: our email with no outside recipient, internal.
CREATE FUNCTION pg_temp.ga_before_rule(p_row jsonb) RETURNS jsonb LANGUAGE sql AS $$
 SELECT p_row || jsonb_build_object('event_type', 'staff.email_internal', 'direction', 'internal',
  'payload', ((p_row -> 'payload') - 'audience_basis') || jsonb_build_object('email', NULL::text)) $$;
CREATE FUNCTION pg_temp.ga_row(p_key text) RETURNS public.business_events LANGUAGE sql AS $$
 SELECT b.* FROM public.business_events b WHERE b.provider_message_id = p_key $$;
CREATE FUNCTION pg_temp.ga_lanes(p_on boolean) RETURNS void LANGUAGE sql AS $$
 UPDATE public.automation_switches SET capture = p_on, attribution = p_on, extraction = p_on, all_stop = false WHERE id = 1 $$;

CREATE TEMP TABLE ga_rows (label text PRIMARY KEY, r jsonb NOT NULL);
-- ROWS BEGIN
INSERT INTO ga_rows (label, r) VALUES
 ('r_reply_group','{"event_type":"client.email_out","source":"outlook-mail-capture","entity_type":"email","entity_id":"email:gma-reply-0002@secureworkswa.com.au","job_id":null,"match_method":"none","event_at":"2026-10-01T02:00:00Z","provider_message_id":"email:gma-reply-0002@secureworkswa.com.au","channel":"email","direction":"outbound","thread_key":null,"body_preview":"Subject: Our Ref: BLD-99001 - 1 Example Street\n\nHi team, booked in for Friday.","safe_summary":"Subject: Our Ref: BLD-99001 - 1 Example Street\n\nHi team, booked in for Friday.","privacy_classification":"staff_only","retention_class":"7y_audit","payload":{"body":"Subject: Our Ref: BLD-99001 - 1 Example Street\n\nHi team, booked in for Friday.","subject":"Our Ref: BLD-99001 - 1 Example Street","email":"coordinator@builder.example","from":"admin@secureworkswa.com.au","to":[],"cc":[],"mailbox":"ses@secureworkswa.com.au","folder_kind":"group","delivered_to":null,"line":null,"sender_kind":"ours","sent_by_kind":"staff_email","sent_by_user":"admin@secureworkswa.com.au","internet_message_id":"gma-reply-0002@secureworkswa.com.au","conversation_id":null,"body_source":"post_body_cut","body_truncated":false,"body_chars_total":78,"has_attachments":false,"attachments":[],"attachments_total":0,"references":[],"event_at_source":"provider","audience_basis":"group_thread"},"metadata":{"capture_mode":"live","capture_path":"outlook_mail_v1"}}'::jsonb),
 ('r_alone_group','{"event_type":"staff.email_unknown_audience","source":"outlook-mail-capture","entity_type":"email","entity_id":"email:gma-alone-0003@secureworkswa.com.au","job_id":null,"match_method":"none","event_at":"2026-10-01T03:00:00Z","provider_message_id":"email:gma-alone-0003@secureworkswa.com.au","channel":"email","direction":"outbound","thread_key":null,"body_preview":"Subject: BLD-99001 - Xero invoice INV-99001\n\nPlease find attached our invoice.","safe_summary":"Subject: BLD-99001 - Xero invoice INV-99001\n\nPlease find attached our invoice.","privacy_classification":"staff_only","retention_class":"7y_audit","payload":{"body":"Subject: BLD-99001 - Xero invoice INV-99001\n\nPlease find attached our invoice.","subject":"BLD-99001 - Xero invoice INV-99001","email":null,"from":"admin@secureworkswa.com.au","to":[],"cc":[],"mailbox":"finance@secureworkswa.com.au","folder_kind":"group","delivered_to":null,"line":null,"sender_kind":"ours","sent_by_kind":"staff_email","sent_by_user":"admin@secureworkswa.com.au","internet_message_id":"gma-alone-0003@secureworkswa.com.au","conversation_id":null,"body_source":"post_body_cut","body_truncated":false,"body_chars_total":78,"has_attachments":false,"attachments":[],"attachments_total":0,"references":["INV-99001"],"event_at_source":"provider","audience_basis":"unknown"},"metadata":{"capture_mode":"live","capture_path":"outlook_mail_v1"}}'::jsonb),
 ('r_reply_sent','{"event_type":"client.email_out","source":"outlook-mail-capture","entity_type":"email","entity_id":"email:gma-reply-0002@secureworkswa.com.au","job_id":null,"match_method":"none","event_at":"2026-10-01T02:00:00Z","provider_message_id":"email:gma-reply-0002@secureworkswa.com.au","channel":"email","direction":"outbound","thread_key":"outlook:AAQkAGGmaConvReply04=","body_preview":"Subject: RE: Our Ref: BLD-99001 - 1 Example Street\n\nHi team, booked in for Friday.","safe_summary":"Subject: RE: Our Ref: BLD-99001 - 1 Example Street\n\nHi team, booked in for Friday.","privacy_classification":"staff_only","retention_class":"7y_audit","payload":{"body":"Subject: RE: Our Ref: BLD-99001 - 1 Example Street\n\nHi team, booked in for Friday.","subject":"RE: Our Ref: BLD-99001 - 1 Example Street","email":"coordinator@builder.example","from":"admin@secureworkswa.com.au","to":["coordinator@builder.example"],"cc":["ses@secureworkswa.com.au"],"mailbox":"admin@secureworkswa.com.au","folder_kind":"sent","delivered_to":null,"line":null,"sender_kind":"ours","sent_by_kind":"staff_email","sent_by_user":"admin@secureworkswa.com.au","internet_message_id":"gma-reply-0002@secureworkswa.com.au","conversation_id":"AAQkAGGmaConvReply04=","body_source":"unique_body","body_truncated":false,"body_chars_total":82,"has_attachments":false,"attachments":[],"attachments_total":0,"references":[],"event_at_source":"provider"},"metadata":{"capture_mode":"live","capture_path":"outlook_mail_v1"}}'::jsonb),
 ('r_forward_sent','{"event_type":"staff.email_internal","source":"outlook-mail-capture","entity_type":"email","entity_id":"email:gma-forward-0005@secureworkswa.com.au","job_id":null,"match_method":"none","event_at":"2026-10-01T04:00:00Z","provider_message_id":"email:gma-forward-0005@secureworkswa.com.au","channel":"email","direction":"internal","thread_key":"outlook:AAQkAGGmaConvForward05=","body_preview":"Subject: FW: Our Ref: BLD-99001 - 1 Example Street\n\nFor the file.","safe_summary":"Subject: FW: Our Ref: BLD-99001 - 1 Example Street\n\nFor the file.","privacy_classification":"staff_only","retention_class":"7y_audit","payload":{"body":"Subject: FW: Our Ref: BLD-99001 - 1 Example Street\n\nFor the file.","subject":"FW: Our Ref: BLD-99001 - 1 Example Street","email":null,"from":"admin@secureworkswa.com.au","to":["ses@secureworkswa.com.au"],"cc":[],"mailbox":"admin@secureworkswa.com.au","folder_kind":"sent","delivered_to":null,"line":null,"sender_kind":"ours","sent_by_kind":"staff_email","sent_by_user":"admin@secureworkswa.com.au","internet_message_id":"gma-forward-0005@secureworkswa.com.au","conversation_id":"AAQkAGGmaConvForward05=","body_source":"unique_body","body_truncated":false,"body_chars_total":65,"has_attachments":false,"attachments":[],"attachments_total":0,"references":[],"event_at_source":"provider"},"metadata":{"capture_mode":"live","capture_path":"outlook_mail_v1"}}'::jsonb);
-- ROWS END
CREATE FUNCTION pg_temp.ga_r(p_label text) RETURNS jsonb LANGUAGE sql AS $$ SELECT r FROM ga_rows WHERE label = p_label $$;

-- 1. Shape.
DO $c$
DECLARE f text;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_email_audience_topic(text)', 'public.context_email_audience_plan()',
  'public.context_email_audience_backfill(boolean)', 'public.context_email_audience_resolve(jsonb)'] LOOP
  PERFORM pg_temp.ga_assert(to_regprocedure(f) IS NOT NULL, f || ' missing');
  PERFORM pg_temp.ga_assert(obj_description(to_regprocedure(f), 'pg_proc') LIKE 'Group mailbox audience (20261009131000): %',
   f || ' comment is not the marker');
  PERFORM pg_temp.ga_assert(has_function_privilege('service_role', f, 'EXECUTE'), 'service_role cannot execute ' || f);
  PERFORM pg_temp.ga_assert(NOT has_function_privilege('anon', f, 'EXECUTE') AND NOT has_function_privilege('authenticated', f, 'EXECUTE'),
   f || ' executable by anon or authenticated');
  PERFORM pg_temp.ga_assert(NOT EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   WHERE p.oid = to_regprocedure(f) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'), f || ' executable by PUBLIC');
  IF f = 'public.context_email_audience_topic(text)' THEN
   PERFORM pg_temp.ga_assert((SELECT NOT p.prosecdef AND p.proconfig IS NULL AND p.provolatile = 'i'
     AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'sql') FROM pg_proc p WHERE p.oid = to_regprocedure(f)),
    'the topic must be inlinable immutable SQL with no SET');
  ELSE
   PERFORM pg_temp.ga_assert((SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp'] FROM pg_proc p
     WHERE p.oid = to_regprocedure(f)), f || ' must be definer with search_path public, pg_temp');
  END IF;
 END LOOP;
 PERFORM pg_temp.ga_assert(public.context_email_audience_topic('RE: FW:  Our Ref: BLD-99001 -  1 Example Street ')
  = 'our ref: bld-99001 - 1 example street', 'topic drops Re: and Fw:, collapses spaces, lower case');
 PERFORM pg_temp.ga_assert(public.context_email_audience_topic('fwd:Quote') = 'quote' AND public.context_email_audience_topic(NULL) = ''
  AND public.context_email_audience_topic('Re-roof quote') = 're-roof quote', 'topic: Fwd:, null, and a word that only starts with re');
END $c$;

-- 2. The reader's resolver.
BEGIN;
DO $c$
DECLARE out jsonb; e public.business_events; c0 timestamptz := '2026-10-01 05:00Z'; c1 timestamptz;
 k_reply constant text := 'email:gma-reply-0002@secureworkswa.com.au';
 k_alone constant text := 'email:gma-alone-0003@secureworkswa.com.au';
 k_fwd constant text := 'email:gma-forward-0005@secureworkswa.com.au';
BEGIN
 PERFORM pg_temp.ga_lanes(true);
 -- The group copy of our reply was saved first, before the rule: internal.
 PERFORM pg_temp.ga_store(pg_temp.ga_before_rule(pg_temp.ga_r('r_reply_group')));
 -- The group re-read (the thread names the builder): relabelled, from the weakest basis.
 out := public.context_email_audience_resolve(pg_temp.ga_r('r_reply_group'));
 PERFORM pg_temp.ga_assert(out ->> 'outcome' = 'relabelled' AND out ->> 'basis' = 'group_thread' AND out ->> 'from_basis' = 'before_rule',
  'a group copy that reads its thread relabels the row saved before the rule: ' || out::text);
 e := pg_temp.ga_row(k_reply);
 PERFORM pg_temp.ga_assert(e.event_type = 'client.email_out' AND e.direction = 'outbound'
  AND e.payload ->> 'email' = 'coordinator@builder.example' AND e.payload ->> 'audience_basis' = 'group_thread'
  AND e.payload -> 'to' = '[]'::jsonb AND NOT e.payload ? 'recipients_from', 'the group copy''s label: ' || to_jsonb(e)::text);
 PERFORM pg_temp.ga_assert(e.metadata #>> '{audience_relabel,rule}' = 'group_mailbox_audience_v1'
  AND e.metadata #>> '{audience_relabel,by}' = 'context_email_audience_resolve'
  AND e.metadata #>> '{audience_relabel,original,event_type}' = 'staff.email_internal'
  AND e.metadata #>> '{audience_relabel,original,direction}' = 'internal'
  AND e.metadata #> '{audience_relabel,original,email}' = 'null'::jsonb
  AND (e.metadata #>> '{audience_relabel,original,captured_at}')::timestamptz = c0
  AND e.metadata #>> '{audience_relabel,from,basis}' = 'before_rule', 'the relabel keeps the original: ' || (e.metadata -> 'audience_relabel')::text);
 PERFORM pg_temp.ga_assert(e.context_captured_at > c0 AND e.context_captured_at = (e.metadata #>> '{audience_relabel,at}')::timestamptz
  AND e.occurred_at = c0, 'the relabel moves the landed time, never the capture''s own: ' || e.context_captured_at::text);
 PERFORM pg_temp.ga_assert(e.metadata #>> '{party_roles,audience}' IS DISTINCT FROM 'internal'
  AND e.metadata #>> '{party_roles,sender_role}' = 'staff' AND e.metadata #>> '{party_roles,recipient_role}' IS DISTINCT FROM 'staff',
  'the relabelled row is re-stamped, never staff to staff: ' || coalesce((e.metadata -> 'party_roles')::text, '<none>'));
 c1 := e.context_captured_at;
 -- The sender's Sent Items copy: the same label on the strongest basis is recorded alone.
 out := public.context_email_audience_resolve(pg_temp.ga_r('r_reply_sent'));
 PERFORM pg_temp.ga_assert(out ->> 'outcome' = 'confirmed' AND out ->> 'basis' = 'mailbox_copy', 'the same label is confirmed: ' || out::text);
 e := pg_temp.ga_row(k_reply);
 PERFORM pg_temp.ga_assert(e.payload ->> 'audience_basis' = 'mailbox_copy' AND e.event_type = 'client.email_out'
  AND e.context_captured_at = c1 AND e.metadata #>> '{audience_relabel,from,basis}' = 'before_rule',
  'a confirmation moves nothing but the basis: ' || to_jsonb(e)::text);
 -- Weaker or equal copies never move it.
 PERFORM pg_temp.ga_assert(public.context_email_audience_resolve(pg_temp.ga_r('r_reply_group')) ->> 'outcome' = 'unchanged'
  AND public.context_email_audience_resolve(pg_temp.ga_r('r_reply_sent')) ->> 'outcome' = 'unchanged', 'a weaker or equal copy is unchanged');

 -- Our invoice email's group copy alone in its thread: unknown audience, never internal.
 PERFORM pg_temp.ga_store(pg_temp.ga_before_rule(pg_temp.ga_r('r_alone_group')));
 out := public.context_email_audience_resolve(pg_temp.ga_r('r_alone_group'));
 e := pg_temp.ga_row(k_alone);
 PERFORM pg_temp.ga_assert(out ->> 'outcome' = 'relabelled' AND e.event_type = 'staff.email_unknown_audience' AND e.direction = 'outbound'
  AND e.payload -> 'email' = 'null'::jsonb AND e.payload ->> 'audience_basis' = 'unknown' AND e.context_captured_at > c0,
  'a group copy with no outside party in its thread is unknown audience: ' || to_jsonb(e)::text);
 PERFORM pg_temp.ga_assert(e.metadata #>> '{party_roles,audience}' = 'unknown' AND e.metadata #>> '{party_roles,sender_role}' = 'staff'
  AND e.metadata #>> '{party_roles,recipient_role}' = 'unknown', 'unknown audience is stamped staff to unknown: '
  || coalesce((e.metadata -> 'party_roles')::text, '<none>'));
 PERFORM pg_temp.ga_assert(public.context_email_audience_resolve(pg_temp.ga_r('r_alone_group')) ->> 'outcome' = 'unchanged',
  'the same unknown copy again is unchanged');

 -- A forward into the group, saved from the group as a reply in the builder's thread; its Sent
 -- Items copy (sent to the group only) relabels it internal, To and Cc from the copy, and keeps the
 -- original from before.
 PERFORM pg_temp.ga_store(pg_temp.ga_r('r_reply_group') || jsonb_build_object('provider_message_id', k_fwd, 'entity_id', k_fwd));
 out := public.context_email_audience_resolve(pg_temp.ga_r('r_forward_sent'));
 e := pg_temp.ga_row(k_fwd);
 PERFORM pg_temp.ga_assert(out ->> 'outcome' = 'relabelled' AND out ->> 'from_basis' = 'group_thread'
  AND e.event_type = 'staff.email_internal' AND e.direction = 'internal' AND e.payload -> 'email' = 'null'::jsonb
  AND e.payload ->> 'audience_basis' = 'mailbox_copy' AND e.payload -> 'to' = '["ses@secureworkswa.com.au"]'::jsonb
  AND e.payload -> 'cc' = '[]'::jsonb AND e.payload ->> 'recipients_from' = 'admin@secureworkswa.com.au'
  AND e.metadata #>> '{audience_relabel,original,event_type}' = 'client.email_out'
  AND e.metadata #>> '{audience_relabel,original,audience_basis}' = 'group_thread',
  'a mailbox copy to the group only relabels a thread guess internal: ' || to_jsonb(e)::text);
 PERFORM pg_temp.ga_assert(e.metadata #>> '{party_roles,audience}' = 'internal', 'a forward to our own group stays staff to staff');
END $c$;
ROLLBACK;

BEGIN;
DO $c$
DECLARE out jsonb; e public.business_events; v uuid; r jsonb;
 k_reply constant text := 'email:gma-reply-0002@secureworkswa.com.au';
BEGIN
 PERFORM pg_temp.ga_lanes(true);
 -- Nothing saved under the key.
 PERFORM pg_temp.ga_assert(public.context_email_audience_resolve(pg_temp.ga_r('r_reply_group')) ->> 'outcome' = 'not_found', 'not_found');
 -- The mailbox copy was saved first, with its recipients: no group copy moves it.
 v := pg_temp.ga_store(pg_temp.ga_r('r_reply_sent'));
 out := public.context_email_audience_resolve(pg_temp.ga_r('r_reply_group'));
 PERFORM pg_temp.ga_assert(out ->> 'outcome' = 'unchanged' AND out ->> 'basis' = 'recipients', 'recipients are never moved: ' || out::text);
 PERFORM pg_temp.ga_assert(public.context_email_audience_resolve(pg_temp.ga_r('r_reply_sent')) ->> 'outcome' = 'unchanged',
  'the same mailbox copy again is unchanged');
 -- Shapes refused: nothing is read or written.
 FOR r IN SELECT x FROM jsonb_array_elements(jsonb_build_array(
   '[]'::jsonb, '{}'::jsonb,
   pg_temp.ga_r('r_reply_group') - 'payload',
   jsonb_set(pg_temp.ga_r('r_reply_group'), '{payload,sender_kind}', '"customer"'),
   jsonb_set(pg_temp.ga_r('r_reply_group'), '{event_type}', '"staff.email_internal"'),
   jsonb_set(pg_temp.ga_r('r_reply_group'), '{provider_message_id}', '"graph:ses@secureworkswa.com.au:x"'),
   jsonb_set(pg_temp.ga_r('r_reply_group'), '{source}', '"monitor-inbox"'),
   jsonb_set(pg_temp.ga_r('r_reply_group'), '{channel}', '"sms"'),
   jsonb_set(pg_temp.ga_r('r_reply_group'), '{payload,audience_basis}', '"mailbox_copy"'),
   jsonb_set(pg_temp.ga_r('r_reply_group'), '{payload,email}', 'null'),
   jsonb_set(pg_temp.ga_r('r_alone_group'), '{payload,email}', '"coordinator@builder.example"'),
   jsonb_set(pg_temp.ga_r('r_reply_sent'), '{payload,audience_basis}', '"unknown"'),
   jsonb_set(jsonb_set(pg_temp.ga_r('r_reply_sent'), '{payload,to}', '[]'), '{payload,cc}', '[]'),
   jsonb_set(pg_temp.ga_r('r_forward_sent'), '{direction}', '"outbound"'))) x LOOP
  out := public.context_email_audience_resolve(r);
  PERFORM pg_temp.ga_assert(out = '{"outcome": "refused", "code": "audience_row_invalid"}'::jsonb, 'a bad shape is refused: ' || out::text);
 END LOOP;
 PERFORM pg_temp.ga_assert(public.context_email_audience_resolve(NULL) ->> 'code' = 'audience_row_invalid', 'a null row is refused');
 DELETE FROM public.business_events WHERE id = v;
 -- Someone else's row under the key: never ours to relabel.
 v := pg_temp.ga_store(pg_temp.ga_r('r_reply_group') || jsonb_build_object('event_type', 'client.email_in', 'direction', 'inbound',
  'payload', (pg_temp.ga_r('r_reply_group') -> 'payload') - 'audience_basis' || '{"sender_kind": "customer"}'::jsonb));
 out := public.context_email_audience_resolve(pg_temp.ga_r('r_reply_group'));
 e := pg_temp.ga_row(k_reply);
 PERFORM pg_temp.ga_assert(out ->> 'outcome' = 'unchanged' AND out ->> 'basis' = 'not_our_email' AND e.event_type = 'client.email_in'
  AND NOT e.metadata ? 'audience_relabel', 'someone else''s row is unchanged: ' || out::text);
 DELETE FROM public.business_events WHERE id = v;
 -- The capture lane off: nothing.
 v := pg_temp.ga_store(pg_temp.ga_before_rule(pg_temp.ga_r('r_reply_group')));
 PERFORM pg_temp.ga_lanes(false);
 PERFORM pg_temp.ga_assert(public.context_email_audience_resolve(pg_temp.ga_r('r_reply_group')) = '{"outcome": "capture_disabled"}'::jsonb,
  'the capture lane off writes nothing');
 PERFORM pg_temp.ga_assert((SELECT b.event_type = 'staff.email_internal' AND NOT b.payload ? 'audience_basis' FROM public.business_events b
  WHERE b.id = v), 'the lane off left the row as it was');
END $c$;
ROLLBACK;

-- 3. The plan, the relabel and the judge.
BEGIN;
CREATE TEMP TABLE ga_before ON COMMIT DROP AS SELECT NULL::uuid AS id, NULL::text AS v LIMIT 0;
DO $c$
DECLARE j1 uuid; j2 uuid; t1 constant text := 'Our Ref: BLD-99001 - 1 Example Street';
 t3 constant text := 'Our Ref: BLD-99003 - 3 Example Street'; ses constant text := 'ses@secureworkswa.com.au';
 fin constant text := 'finance@secureworkswa.com.au'; adm constant text := 'admin@secureworkswa.com.au';
 co constant text := 'coordinator@builder.example';
BEGIN
 j1 := pg_temp.ga_job(1, 'SWMS-990101');
 j2 := pg_temp.ga_job(2, 'SWMS-990102');
 -- The builder's thread in the ses@ group, a later second sender, and another thread whose outside post comes after ours.
 PERFORM pg_temp.ga_ev(1, j1, 'client.email_in', 'inbound', pg_temp.ga_payload(ses, 'group', co, t1, 'Can you confirm the date?', co, '[]', '[]', 'customer'),
  '2026-09-01 01:00Z');
 PERFORM pg_temp.ga_ev(12, j1, 'client.email_in', 'inbound', pg_temp.ga_payload(ses, 'group', 'site.manager@builder.example', t1, 'Any update?',
  'site.manager@builder.example', '[]', '[]', 'customer'), '2026-09-04 01:00Z');
 PERFORM pg_temp.ga_ev(13, j1, 'client.email_in', 'inbound', pg_temp.ga_payload(ses, 'group', 'coordinator2@builder.example', 'RE: ' || t3,
  'Thanks.', 'coordinator2@builder.example', '[]', '[]', 'customer'), '2026-09-02 01:00Z');
 -- Our posts, saved internal before the rule.
 PERFORM pg_temp.ga_ev(2, j1, 'staff.email_internal', 'internal', pg_temp.ga_payload(ses, 'group', adm, t1, 'Booked in for Friday.'), '2026-09-01 02:00Z');
 PERFORM pg_temp.ga_ev(3, j1, 'staff.email_internal', 'internal', pg_temp.ga_payload(ses, 'group', adm, t1, 'Materials ordered.'), '2026-09-03 03:00Z');
 PERFORM pg_temp.ga_ev(4, j1, 'staff.email_internal', 'internal', pg_temp.ga_payload(ses, 'group', adm, t3, 'Measure on Monday.'), '2026-09-01 00:30Z');
 PERFORM pg_temp.ga_ev(5, j1, 'staff.email_internal', 'internal', pg_temp.ga_payload(fin, 'group', adm, 'BLD-99001 - Xero invoice INV-99001',
  'Invoice attached.'), '2026-09-05 01:00Z');
 PERFORM pg_temp.ga_ev(6, j1, 'staff.email_internal', 'internal', pg_temp.ga_payload(ses, 'group', adm, t1, 'For the file.'), '2026-09-02 05:00Z');
 PERFORM pg_temp.ga_ev(7, j1, 'staff.email_internal', 'internal', pg_temp.ga_payload(fin, 'group', adm, 'BLD-99002 - Xero invoice INV-99002',
  'Invoice attached.'), '2026-09-06 04:00Z');
 -- Mailbox rows: one with only our recipients (internal, as recorded), one with none recorded (unknown: a mailbox row never reads a thread).
 PERFORM pg_temp.ga_ev(8, j1, 'staff.email_internal', 'internal', pg_temp.ga_payload(adm, 'sent', adm, t1, 'Team note.', NULL, '["ses@secureworkswa.com.au"]'),
  '2026-09-07 01:00Z');
 PERFORM pg_temp.ga_ev(9, j1, 'staff.email_internal', 'internal', pg_temp.ga_payload(adm, 'sent', adm, t1, 'No recipients recorded.'), '2026-09-08 01:00Z');
 -- Never the rule's: someone else's email, a row the new reader labelled, another writer's internal row.
 PERFORM pg_temp.ga_ev(10, NULL, 'client.email_in', 'inbound', pg_temp.ga_payload(ses, 'group', 'pat.example@example.com',
  'Question about a fence', 'Hello.', 'pat.example@example.com', '[]', '[]', 'customer'), '2026-09-02 02:00Z');
 PERFORM pg_temp.ga_ev(11, j1, 'client.email_out', 'outbound', pg_temp.ga_payload(ses, 'group', adm, t1, 'Already labelled.', co)
  || '{"audience_basis": "group_thread"}'::jsonb, '2026-09-02 03:00Z');
 PERFORM pg_temp.ga_ev(14, j1, 'staff.email_internal', 'internal', pg_temp.ga_payload(ses, 'group', adm, t1, 'Old path.'), '2026-09-02 04:00Z',
  'monitor-inbox');
 -- A post of ours on the second job inside 14 days of its reading.
 PERFORM pg_temp.ga_ev(15, j2, 'staff.email_internal', 'internal', pg_temp.ga_payload(ses, 'group', adm, 'Our Ref: BLD-99004 - 4 Example Street',
  'On our way.'), '2026-09-25 01:00Z');
 -- The old inbox's copies: of post 2 (same instant, To the group and the builder), of post 6 (40 seconds later,
 -- Fw:, To the group only), and an unrelated email 37 seconds before post 7 (another subject: no copy of it).
 PERFORM pg_temp.ga_inbox(2, 'Admin <admin@secureworkswa.com.au>', '2026-09-01 02:00Z', 'RE: ' || t1,
  'ses@secureworkswa.com.au, Jo Coordinator <coordinator@builder.example>');
 PERFORM pg_temp.ga_inbox(6, adm, '2026-09-02 05:00:40Z', 'Fw: ' || t1, 'ses@secureworkswa.com.au');
 PERFORM pg_temp.ga_inbox(7, adm, '2026-09-06 03:59:23Z', 'Re: Something else', 'someone@elsewhere.example');
END $c$;
INSERT INTO ga_before SELECT b.id, b.ctid::text || '|' || md5(to_jsonb(b)::text) FROM public.business_events b
 WHERE b.id IN (SELECT pg_temp.ga_id(n) FROM generate_series(1, 15) n);
DO $c$
DECLARE p record; d jsonb; n integer;
 co constant text := 'coordinator@builder.example';
BEGIN
 -- The plan, row by row (only these fixtures are this contract's to name).
 CREATE TEMP TABLE ga_plan ON COMMIT DROP AS SELECT * FROM public.context_email_audience_plan();
 PERFORM pg_temp.ga_assert((SELECT array_agg(gp.event_id ORDER BY gp.event_id) FROM ga_plan gp
   WHERE gp.event_id IN (SELECT pg_temp.ga_id(x) FROM generate_series(1, 15) x))
  = (SELECT array_agg(pg_temp.ga_id(x) ORDER BY pg_temp.ga_id(x)) FROM unnest(ARRAY[2, 3, 4, 5, 6, 7, 9, 15]) x),
  'the plan takes exactly our posts saved internal with no recipients: ' || (SELECT string_agg(gp.event_id::text, ', ') FROM ga_plan gp));
 SELECT * INTO p FROM ga_plan WHERE event_id = pg_temp.ga_id(2);
 PERFORM pg_temp.ga_assert(p.basis = 'inbox_copy' AND p.event_type = 'client.email_out' AND p.direction = 'outbound' AND p.email = co
  AND p.recipients = '["ses@secureworkswa.com.au", "coordinator@builder.example"]'::jsonb AND p.copy_id = pg_temp.ga_iid(2)
  AND p.thread_event_id IS NULL, 'the old inbox''s copy decides first: ' || to_jsonb(p)::text);
 SELECT * INTO p FROM ga_plan WHERE event_id = pg_temp.ga_id(3);
 PERFORM pg_temp.ga_assert(p.basis = 'group_thread' AND p.event_type = 'client.email_out' AND p.email = co
  AND p.thread_event_id = pg_temp.ga_id(1) AND p.recipients IS NULL, 'the thread''s newest outside sender at or before the post: '
  || to_jsonb(p)::text);
 SELECT * INTO p FROM ga_plan WHERE event_id = pg_temp.ga_id(4);
 PERFORM pg_temp.ga_assert(p.basis = 'group_thread' AND p.email = 'coordinator2@builder.example' AND p.thread_event_id = pg_temp.ga_id(13),
  'else the earliest after it, across Re: in the subject: ' || to_jsonb(p)::text);
 FOR p IN SELECT * FROM ga_plan WHERE event_id IN (pg_temp.ga_id(5), pg_temp.ga_id(7), pg_temp.ga_id(9), pg_temp.ga_id(15)) LOOP
  PERFORM pg_temp.ga_assert(p.basis = 'unknown' AND p.event_type = 'staff.email_unknown_audience' AND p.direction = 'outbound'
   AND p.email IS NULL AND p.copy_id IS NULL AND p.thread_event_id IS NULL, 'no copy and no thread: unknown: ' || to_jsonb(p)::text);
 END LOOP;
 SELECT * INTO p FROM ga_plan WHERE event_id = pg_temp.ga_id(6);
 PERFORM pg_temp.ga_assert(p.basis = 'inbox_copy' AND p.event_type = 'staff.email_internal' AND p.direction = 'internal' AND p.email IS NULL
  AND p.recipients = '["ses@secureworkswa.com.au"]'::jsonb AND p.copy_id = pg_temp.ga_iid(6),
  'a copy naming only our own addresses keeps it internal, whatever its thread: ' || to_jsonb(p)::text);
 -- The dry run: the plan's counts, nothing written.
 d := public.context_email_audience_backfill();
 PERFORM pg_temp.ga_assert(d ->> 'applied' = 'false'
  AND (d ->> 'relabel')::integer = (SELECT count(*) FROM ga_plan WHERE event_type <> 'staff.email_internal')
  AND (d ->> 'confirm_internal')::integer = (SELECT count(*) FROM ga_plan WHERE event_type = 'staff.email_internal')
  AND (d ->> 'unknown')::integer = (SELECT count(*) FROM ga_plan WHERE basis = 'unknown')
  AND (d ->> 'group_thread')::integer = (SELECT count(*) FROM ga_plan WHERE basis = 'group_thread')
  AND (d ->> 'relabel')::integer >= 7, 'the dry run answers the plan''s counts: ' || d::text);
 PERFORM pg_temp.ga_assert(NOT EXISTS (SELECT 1 FROM public.business_events b JOIN ga_before x ON x.id = b.id
   WHERE b.ctid::text || '|' || md5(to_jsonb(b)::text) <> x.v), 'the dry run wrote nothing');
END $c$;
-- The ledger read every row before the relabel: live readings past all of them.
DO $c$
DECLARE jd record;
BEGIN
 PERFORM pg_temp.ga_lanes(true);
 UPDATE public.context_ledger_settings SET mode = 'shadow', reader = 'ga-reader:v1', job_ids = NULL, backfill_from_hour = NULL,
  backfill_to_hour = NULL;
 INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, evidence_until, promoted_at, created_at, finished_at, updated_at, checks)
 SELECT pg_temp.ga_id(900 + n), 'backfill', 'live', 'ga-reader:v1', '2026-09-30 00:00Z', '2026-09-30 01:00Z', '2026-09-30 00:00Z',
  '2026-09-30 01:00Z', '2026-09-30 01:00Z', '{"passed": true, "store": {"pass": true}}'::jsonb
 FROM generate_series(1, 2) n;
 FOR jd IN SELECT * FROM public.context_ledger_judge(ARRAY[pg_temp.ga_id(901), pg_temp.ga_id(902)]) LOOP
  PERFORM pg_temp.ga_assert(NOT jd.due AND jd.reason IS NULL AND jd.blocked_reason IS NULL,
   'before the relabel the readings are current: ' || to_jsonb(jd)::text);
 END LOOP;
END $c$;
DO $c$
DECLARE d jsonb; e public.business_events; co constant text := 'coordinator@builder.example';
BEGIN
 d := public.context_email_audience_backfill(true);
 PERFORM pg_temp.ga_assert(d ->> 'applied' = 'true' AND (d ->> 'relabelled')::integer >= 7 AND (d ->> 'confirmed_internal')::integer >= 1,
  'the relabel answers what it wrote: ' || d::text);
 SELECT * INTO e FROM public.business_events WHERE id = pg_temp.ga_id(2);
 PERFORM pg_temp.ga_assert(e.event_type = 'client.email_out' AND e.direction = 'outbound' AND e.payload ->> 'email' = co
  AND e.payload ->> 'audience_basis' = 'inbox_copy'
  AND e.payload -> 'to' = '["ses@secureworkswa.com.au", "coordinator@builder.example"]'::jsonb
  AND e.metadata #>> '{audience_relabel,by}' = 'context_email_audience_backfill' AND e.metadata #>> '{audience_relabel,basis}' = 'inbox_copy'
  AND e.metadata #>> '{audience_relabel,copy_id}' = pg_temp.ga_iid(2)::text
  AND e.metadata #>> '{audience_relabel,original,event_type}' = 'staff.email_internal'
  AND e.metadata #> '{audience_relabel,original,to}' = '[]'::jsonb, 'post 2 from its copy: ' || to_jsonb(e)::text);
 PERFORM pg_temp.ga_assert(e.context_captured_at > '2026-09-30 00:00Z'
  AND e.context_captured_at = (e.metadata #>> '{audience_relabel,at}')::timestamptz
  AND (e.metadata #>> '{audience_relabel,original,captured_at}')::timestamptz = '2026-09-01 03:00Z',
  'a relabel moves the row''s landed time and keeps the old one: ' || e.context_captured_at::text);
 PERFORM pg_temp.ga_assert(e.metadata #>> '{party_roles,audience}' IS DISTINCT FROM 'internal' AND e.metadata #>> '{party_roles,sender_role}' = 'staff',
  'post 2 is re-stamped, never internal: ' || coalesce((e.metadata -> 'party_roles')::text, '<none>'));
 SELECT * INTO e FROM public.business_events WHERE id = pg_temp.ga_id(3);
 PERFORM pg_temp.ga_assert(e.event_type = 'client.email_out' AND e.payload ->> 'email' = co AND e.payload ->> 'audience_basis' = 'group_thread'
  AND e.payload -> 'to' = '[]'::jsonb AND e.metadata #>> '{audience_relabel,thread_event_id}' = pg_temp.ga_id(1)::text
  AND e.context_captured_at > '2026-09-30 00:00Z', 'post 3 from its thread: ' || to_jsonb(e)::text);
 SELECT * INTO e FROM public.business_events WHERE id = pg_temp.ga_id(4);
 PERFORM pg_temp.ga_assert(e.payload ->> 'email' = 'coordinator2@builder.example' AND e.payload ->> 'audience_basis' = 'group_thread',
  'post 4 from its thread''s later sender');
 FOR e IN SELECT * FROM public.business_events WHERE id IN (pg_temp.ga_id(5), pg_temp.ga_id(7), pg_temp.ga_id(9), pg_temp.ga_id(15)) LOOP
  PERFORM pg_temp.ga_assert(e.event_type = 'staff.email_unknown_audience' AND e.direction = 'outbound' AND e.payload -> 'email' = 'null'::jsonb
   AND e.payload ->> 'audience_basis' = 'unknown' AND e.context_captured_at > '2026-09-30 00:00Z'
   AND e.metadata #>> '{party_roles,audience}' = 'unknown' AND e.metadata #>> '{party_roles,recipient_role}' = 'unknown',
   'unknown audience, possibly external: ' || to_jsonb(e)::text);
 END LOOP;
 SELECT * INTO e FROM public.business_events WHERE id = pg_temp.ga_id(6);
 PERFORM pg_temp.ga_assert(e.event_type = 'staff.email_internal' AND e.direction = 'internal' AND e.payload ->> 'audience_basis' = 'inbox_copy'
  AND NOT e.metadata ? 'audience_relabel' AND e.context_captured_at = '2026-09-02 06:00Z',
  'post 6 keeps its internal label on the copy''s word and its landed time: ' || to_jsonb(e)::text);
 PERFORM pg_temp.ga_assert(NOT EXISTS (SELECT 1 FROM public.business_events b JOIN ga_before x ON x.id = b.id
   WHERE b.id IN (pg_temp.ga_id(1), pg_temp.ga_id(8), pg_temp.ga_id(10), pg_temp.ga_id(11), pg_temp.ga_id(12), pg_temp.ga_id(13),
    pg_temp.ga_id(14)) AND b.ctid::text || '|' || md5(to_jsonb(b)::text) <> x.v),
  'no other row is written: someone else''s, a mailbox row with recipients, one already labelled, another writer''s');
 -- A second relabel writes nothing.
 DELETE FROM ga_before;
 INSERT INTO ga_before SELECT b.id, b.ctid::text || '|' || md5(to_jsonb(b)::text) FROM public.business_events b
  WHERE b.id IN (SELECT pg_temp.ga_id(n) FROM generate_series(1, 15) n);
 PERFORM public.context_email_audience_backfill(true);
 PERFORM pg_temp.ga_assert(NOT EXISTS (SELECT 1 FROM public.business_events b JOIN ga_before x ON x.id = b.id
   WHERE b.ctid::text || '|' || md5(to_jsonb(b)::text) <> x.v), 'a second relabel wrote a row');
END $c$;
-- As the judge reads once the relabel has committed: a later statement's now() is past the relabel instant. Inside
-- this one transaction now() is its start, so the relabelled rows' landed time is brought to just before it.
UPDATE public.business_events SET context_captured_at = now() - interval '1 second'
WHERE metadata #>> '{audience_relabel,by}' = 'context_email_audience_backfill'
 AND id IN (SELECT pg_temp.ga_id(n) FROM generate_series(1, 15) n);
DO $c$
DECLARE jd record; ev record;
BEGIN
 SELECT * INTO jd FROM public.context_ledger_judge(ARRAY[pg_temp.ga_id(901)]);
 PERFORM pg_temp.ga_assert(jd.due AND jd.kind = 'rebuild' AND jd.reason = 'late_evidence' AND jd.priority = 1 AND jd.blocked_reason IS NULL,
  'a relabelled reading is due again: rebuilt, the rows are weeks older than the reading: ' || to_jsonb(jd)::text);
 SELECT * INTO jd FROM public.context_ledger_judge(ARRAY[pg_temp.ga_id(902)]);
 PERFORM pg_temp.ga_assert(jd.due AND jd.kind = 'update' AND jd.reason = 'new_evidence' AND jd.blocked_reason IS NULL,
  'a relabelled row inside 14 days of the reading is an update: ' || to_jsonb(jd)::text);
 -- The reader's evidence shows the reply as ours to the builder, unread.
 SELECT * INTO ev FROM public.context_ledger_evidence_rows(ARRAY[pg_temp.ga_id(901)], now()) r WHERE r.src_id = pg_temp.ga_id(3);
 PERFORM pg_temp.ga_assert(ev.direction = 'outbound' AND ev.kind = 'client.email_out' AND ev.audience IS DISTINCT FROM 'internal'
  AND ev.ours AND ev.landed_at > '2026-09-30 00:00Z', 'the evidence row: ' || to_jsonb(ev)::text);
END $c$;
ROLLBACK;

-- 4. The migration applied again over stored rows relabels them, changes no body, comment or grant; a further apply writes nothing.
BEGIN;
DO $c$
BEGIN
 PERFORM pg_temp.ga_ev(21, NULL, 'staff.email_internal', 'internal', pg_temp.ga_payload('ses@secureworkswa.com.au', 'group',
  'admin@secureworkswa.com.au', 'Our Ref: BLD-99021', 'Booked.'), '2026-09-10 01:00Z');
 PERFORM pg_temp.ga_inbox(21, 'admin@secureworkswa.com.au', '2026-09-10 01:00Z', 'RE: Our Ref: BLD-99021',
  'ses@secureworkswa.com.au, coordinator@builder.example');
 PERFORM pg_temp.ga_ev(22, NULL, 'staff.email_internal', 'internal', pg_temp.ga_payload('finance@secureworkswa.com.au', 'group',
  'admin@secureworkswa.com.au', 'BLD-99022 - Xero invoice', 'Invoice.'), '2026-09-10 02:00Z');
END $c$;
CREATE TEMP TABLE ga_fn ON COMMIT DROP AS
 SELECT p.oid, md5(p.prosrc) AS m, obj_description(p.oid, 'pg_proc') AS c, p.proacl::text AS acl, p.prosecdef, p.proconfig::text AS cfg
 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'context\_email\_audience\_%';
\ir ../../../migrations/20261009131000_context_group_mailbox_audience.sql
DO $c$
BEGIN
 PERFORM pg_temp.ga_assert((SELECT b.event_type = 'client.email_out' AND b.payload ->> 'email' = 'coordinator@builder.example'
   AND b.payload ->> 'audience_basis' = 'inbox_copy' FROM public.business_events b WHERE b.id = pg_temp.ga_id(21)),
  'the migration relabels a stored post from its copy');
 PERFORM pg_temp.ga_assert((SELECT b.event_type = 'staff.email_unknown_audience' AND b.payload ->> 'audience_basis' = 'unknown'
   FROM public.business_events b WHERE b.id = pg_temp.ga_id(22)), 'the migration relabels a stored post with no copy and no thread unknown');
 PERFORM pg_temp.ga_assert((SELECT count(*) FROM ga_fn) = 4 AND NOT EXISTS (SELECT 1 FROM ga_fn f JOIN pg_proc p ON p.oid = f.oid
   WHERE f.m <> md5(p.prosrc) OR f.c IS DISTINCT FROM obj_description(p.oid, 'pg_proc') OR f.acl IS DISTINCT FROM p.proacl::text
    OR f.prosecdef <> p.prosecdef OR f.cfg IS DISTINCT FROM p.proconfig::text), 're-applying changed a body, comment or grant');
END $c$;
CREATE TEMP TABLE ga_mid ON COMMIT DROP AS
 SELECT b.id, b.ctid::text || '|' || md5(to_jsonb(b)::text) AS v FROM public.business_events b
 WHERE b.id IN (pg_temp.ga_id(21), pg_temp.ga_id(22));
\ir ../../../migrations/20261009131000_context_group_mailbox_audience.sql
DO $c$ BEGIN
 PERFORM pg_temp.ga_assert(NOT EXISTS (SELECT 1 FROM public.business_events b JOIN ga_mid x ON x.id = b.id
   WHERE b.ctid::text || '|' || md5(to_jsonb(b)::text) <> x.v), 'a further apply wrote a row');
END $c$;
ROLLBACK;
