-- Group mailbox audience (9 Oct 2026): our replies from a group mailbox (ses@,
-- finance@, fencing@, patios@) are messages to whoever's thread they are in,
-- not internal notes.
--
-- Why. The email reader (outlook-mail-capture, _shared/evidence/outlook_mail.ts)
-- labelled our own email staff.email_internal (direction internal) whenever it
-- named no outside To or Cc. A group post never names any: Graph lists a post
-- with no recipients. So every reply our staff posted in a builder's or a
-- customer's thread in a group mailbox was saved as internal, the party-roles
-- stamp called it staff to staff (audience internal), and the ledger reader saw
-- the builder's request with no reply after it. The 9 Oct accuracy audit found
-- 29 wrong notes on 8 jobs from this alone. The owner (Marnin, 9 Oct 2026):
-- "fix replies from SES and financing boxes being treated as internal. Sure, fix
-- that."
--
-- The rule, the reader's (TypeScript) and this file's (stored rows) alike. Our
-- own email's outside recipient decides (outbound); recorded recipients that
-- are all ours make it internal. When the row cannot show its recipients (a
-- group post, or a message with none recorded):
--   1. another copy of the same email that shows them decides: the sender's
--      mailbox copy (the reader, through context_email_audience_resolve below)
--      or the old inbox's copy (inbox_events, same sender at the same instant,
--      or within 2 minutes with the same subject; its to_email keeps the To
--      line): an outside address there makes it outbound to that address,
--      only our own addresses keep it internal;
--   2. else, for a group post, its group thread: an outside sender's email in
--      the same thread (a customer, supplier or council; never automated mail
--      or our own) makes it outbound to the newest such sender at or before the
--      post, else the earliest after it. The reader reads the thread Graph
--      lists; a stored row keeps no thread id, so here a thread is the group
--      mailbox's emails with the same topic (the subject without Re: or Fw:);
--   3. else the audience is unknown: staff.email_unknown_audience, direction
--      outbound with no counterpart. The party-roles classifier stamps it
--      sender staff, recipient unknown (basis no_contact), audience unknown, so
--      the ledger store and the reader treat it as possibly external, never as
--      internal: the store's internal checks (context_ledger_cite internal_text,
--      context_job_record_messages internal) and the reader (audience internal,
--      or recipient crew or staff) read the stamp, never the event type.
-- Where a row took its audience from is payload.audience_basis: inbox_copy,
-- group_thread, unknown or mailbox_copy (absent when its own recipients
-- decided). A stronger basis replaces a weaker one only: the email's own
-- recipients or a mailbox copy's, then the old inbox's copy, then the thread,
-- then unknown; a row saved before this rule is weakest.
--
-- Production, read only (9 Oct 2026, about 13:30 Perth; the reader is running,
-- so these move until the migration applies, and it relabels whatever is
-- there then): 3,026 rows from outlook-mail-capture; 398 are our own group
-- posts saved staff.email_internal (ses@ 243, finance@ 94, fencing@ 46,
-- patios@ 15), each with no recipients; no user mailbox row lacks recipients.
-- By this rule: 237 have an old-inbox copy naming an outside recipient
-- (outbound, inbox_copy), 30 have none but an outside party in their thread
-- (outbound, group_thread), 121 have neither (unknown; 92 of them finance@
-- invoice emails sent to a builder with the group copied), and 10 have a copy
-- naming only our own addresses (forwards into a group, a test note: they stay
-- internal and are marked inbox_copy, so no later read can relabel them from
-- their thread). 388 are relabelled, on 157 jobs, 154 of them live. Checked
-- where both an old-inbox copy and a thread party exist (146 posts): the
-- copy named an outside party for 144 (the other two were forwards into the
-- group). 189 of the 267 outbound ones went to the builders' Prime portal
-- mailer (the classifier reads it insurer_builder), 9 to their own job's
-- client.
--
-- How a reading that read the old label is read again. A relabelled row's
-- landed time moves to the relabel: context_captured_at is set to the relabel
-- instant (the captured time it replaces is kept in
-- metadata.audience_relabel.original.captured_at, and the rollback puts it
-- back), so every landed-time reader sees the row as it now reads: the ledger
-- judge (context_ledger_judge: newest landed past the reading's
-- evidence_until) makes each job with a reading due, late_evidence (a rebuild,
-- priority 1) where the row is more than 14 days older than the reading's
-- evidence_until, new_evidence (an update) where it is not, and the story
-- counts the row unread until then. Read only today over the 157 jobs: 135
-- would be late_evidence, 19 new_evidence or late by count, 3 never read; 21
-- are blocked now (3 not live, 18 backoff, busy, needs a person, holding or no
-- evidence) and are read when the block lifts. No judge, packet or reader body
-- changes, and nothing here writes to a ledger table.
--
-- What it adds:
--  1. context_email_audience_topic(text): a subject's topic (lower case, Re:,
--     Fw: and Fwd: dropped, spaces collapsed). Inlinable.
--  2. context_email_audience_plan(): read only. Every stored row the rule
--     labels differently (and every copy-confirmed internal one), with its new
--     label, basis and the copy or thread row that decided it.
--  3. context_email_audience_backfill(p_apply): with p_apply false (the
--     default) the plan's counts, writing nothing; with true the relabel, once
--     per row: event_type, direction, payload.email (the counterpart),
--     payload.audience_basis, payload.to (the old-inbox copy's To line, when a
--     copy decided), context_captured_at, and metadata.audience_relabel
--     {rule, basis, at, by, copy_id, thread_event_id, from, original: the old
--     event_type, direction, email, to, cc, audience_basis and captured_at}.
--     The party-roles trigger re-stamps each row (it fires on these columns).
--     A row already carrying audience_basis is never taken again.
--  4. context_email_audience_resolve(p_row): the reader's call when a copy of
--     our own email meets the row another copy saved (a duplicate key). p_row
--     is that copy's row as outlook_mail.ts built it. Relabels the saved row
--     (with the same metadata and landed time) when the copy's basis is
--     stronger and its label differs; records the stronger basis alone when
--     the label is the same (confirmed); otherwise unchanged. Only rows of our
--     own email from this reader; refused for any other shape; nothing while
--     the capture lane is off.
--  5. Runs the backfill once.
-- Not changed: the ladder (no row is placed again), the classifier, the
-- capture writer, every ledger and story body, every flag and switch.
-- Known, left as it is: context_ledger_mail_copies matches an old-inbox mail
-- to its saved copy by sender and instant only for inbound mail and
-- staff.email_internal, so a relabelled row no longer times such a mail's
-- joined_at; measured 9 Oct: none of the 239 old-inbox copies of these posts
-- sits on a job other than its saved copy's, so nothing reads differently.
-- The old poller's own copies of our mail (monitor-inbox rows typed inbound
-- from our address, 151 of them for 93 of these posts, 44 placed on a job) are
-- a separate class and are not touched.
--
-- Deploy order: this applies before the reader's new code (the deploy
-- workflow applies migrations first); the new reader calls
-- context_email_audience_resolve (scripts/edge-function-schema-requirements.txt).
-- Rollback: supabase/rollbacks/20261009131000_context_group_mailbox_audience_down.sql
-- (every relabelled row back to its original label, payload and captured time;
-- rows the new reader wrote under the rule back to the old rule's internal
-- label; the recorded bases taken off; the four functions dropped). Redeploy
-- the previous outlook-mail-capture with it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[] := '{}'; x record; f text; t text;
BEGIN
 -- Read, never replaced.
 FOREACH f IN ARRAY ARRAY['public.automation_lane_enabled(text)', 'public.context_message_party_roles(public.business_events)'] LOOP
  IF to_regprocedure(f) IS NULL THEN problems := problems || format('%s missing', f); END IF;
 END LOOP;
 -- The columns the plan, the relabel and the resolver read and write.
 FOREACH t IN ARRAY ARRAY['business_events.event_type', 'business_events.direction', 'business_events.channel',
   'business_events.source', 'business_events.payload', 'business_events.metadata', 'business_events.provider_message_id',
   'business_events.event_at', 'business_events.occurred_at', 'business_events.context_captured_at', 'business_events.job_id',
   'inbox_events.from_email', 'inbox_events.to_email', 'inbox_events.received_at', 'inbox_events.subject'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.' || split_part(t, '.', 1))
    AND a.attname = split_part(t, '.', 2) AND a.attnum > 0 AND NOT a.attisdropped) THEN
   problems := problems || format('public.%s missing', t);
  END IF;
 END LOOP;
 -- The party-roles trigger re-stamps a relabelled row; the resolver reads a row by its key.
 IF NOT EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid = to_regclass('public.business_events')
   AND tg.tgname = 'context_party_roles_business_event' AND NOT tg.tgisinternal) THEN
  problems := problems || 'trigger context_party_roles_business_event missing on public.business_events'::text;
 END IF;
 IF to_regclass('public.business_events_provider_message_unique') IS NULL THEN
  problems := problems || 'index public.business_events_provider_message_unique missing'::text;
 END IF;
 -- New objects: absent, or this migration's (comment marker).
 FOR x IN SELECT p.oid::regprocedure::text AS sig, coalesce(obj_description(p.oid, 'pg_proc'), '') AS c
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('context_email_audience_topic', 'context_email_audience_plan', 'context_email_audience_backfill',
    'context_email_audience_resolve') LOOP
  IF x.c NOT LIKE 'Group mailbox audience (20261009131000)%' THEN
   problems := problems || format('%s exists and is not this migration''s', x.sig);
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_group_mailbox_audience_preimage_mismatch: %; read the live definitions before replacing them',
   array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. A subject's topic. Plain SQL with no SET, so it inlines.
CREATE OR REPLACE FUNCTION public.context_email_audience_topic(p_subject text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
 SELECT pg_catalog.lower(pg_catalog.btrim(pg_catalog.regexp_replace(
  pg_catalog.regexp_replace(coalesce(p_subject, ''), '^\s*((re|fw|fwd)\s*:\s*)+', '', 'i'), '\s+', ' ', 'g')))
$fn$;
COMMENT ON FUNCTION public.context_email_audience_topic(text) IS
 'Group mailbox audience (20261009131000): an email subject''s topic: Re:, Fw: and Fwd: prefixes dropped (any number, any case), spaces collapsed, trimmed, lower case; '''' for none. A group post''s subject is its thread''s topic. Inlinable (no SET). Service role only.';

-- 2. The plan: every stored row the rule labels differently, read only.
CREATE OR REPLACE FUNCTION public.context_email_audience_plan()
RETURNS TABLE(event_id uuid, job_id uuid, basis text, event_type text, direction text, email text, recipients jsonb,
 copy_id uuid, thread_event_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
 WITH c AS MATERIALIZED (
  -- Our own email the reader saved internal before this rule, whose row cannot show
  -- its recipients: a group post, or a message with none recorded.
  SELECT b.id, b.job_id, coalesce(b.event_at, b.occurred_at) AS at,
   lower(btrim(coalesce(substring(b.payload ->> 'from' FROM '<([^<>]*)>'), b.payload ->> 'from'))) AS sender,
   lower(btrim(b.payload ->> 'mailbox')) AS mailbox,
   coalesce(b.payload ->> 'folder_kind' = 'group', false) AS from_group,
   public.context_email_audience_topic(b.payload ->> 'subject') AS topic
  FROM public.business_events b
  WHERE b.event_type = 'staff.email_internal' AND b.source = 'outlook-mail-capture' AND b.channel = 'email'
   AND b.payload ->> 'sender_kind' = 'ours' AND NOT b.payload ? 'audience_basis'
   AND (b.payload ->> 'folder_kind' = 'group'
    OR (jsonb_array_length(CASE WHEN jsonb_typeof(b.payload -> 'to') = 'array' THEN b.payload -> 'to' ELSE '[]'::jsonb END) = 0
     AND jsonb_array_length(CASE WHEN jsonb_typeof(b.payload -> 'cc') = 'array' THEN b.payload -> 'cc' ELSE '[]'::jsonb END) = 0))
 ), cp AS (
  -- The old inbox's copies of the same email (context_email_legacy_copy's match, read on
  -- inbox_events): the same sender at the same instant, or within 2 minutes with the same
  -- topic. Its To line, every address in order.
  SELECT c.id, i.id AS copy_id, i.received_at, i.received_at = c.at AS same_instant,
   coalesce((SELECT jsonb_agg(a.addr ORDER BY u.n)
     FROM unnest(string_to_array(coalesce(i.to_email, ''), ',')) WITH ORDINALITY u(raw, n)
     CROSS JOIN LATERAL (SELECT lower(btrim(coalesce(substring(u.raw FROM '<([^<>]*)>'), u.raw))) AS addr) a
     WHERE a.addr ~ '^[^@\s<>]+@[a-z0-9-]+(\.[a-z0-9-]+)+$'), '[]'::jsonb) AS rcpt
  FROM c JOIN public.inbox_events i ON c.sender <> ''
   AND lower(btrim(coalesce(substring(i.from_email FROM '<([^<>]*)>'), i.from_email))) = c.sender
   AND i.received_at BETWEEN c.at - interval '2 minutes' AND c.at + interval '2 minutes'
   AND (i.received_at = c.at OR (c.topic <> '' AND public.context_email_audience_topic(i.subject) = c.topic))
 ), cpo AS (
  SELECT cp.*,
   (SELECT x.a FROM jsonb_array_elements_text(cp.rcpt) WITH ORDINALITY x(a, n)
    WHERE split_part(x.a, '@', 2) !~ '(^|\.)(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$'
    ORDER BY x.n LIMIT 1) AS outside
  FROM cp
 ), cpd AS (
  -- One copy decides: one naming an outside recipient first, then the same instant, then the earliest.
  SELECT DISTINCT ON (o.id) o.id, o.copy_id, o.rcpt, o.outside
  FROM cpo o WHERE jsonb_array_length(o.rcpt) > 0
  ORDER BY o.id, (o.outside IS NULL), o.same_instant DESC, o.received_at, o.copy_id
 ), th AS (
  -- A group post's thread: an outside sender's email in the same group mailbox with the same
  -- topic (a customer, supplier or council by the reader's sender kind); the newest at or
  -- before the post, else the earliest after it.
  SELECT DISTINCT ON (c.id) c.id, o.id AS row_id,
   lower(btrim(coalesce(substring(o.payload ->> 'from' FROM '<([^<>]*)>'), o.payload ->> 'from'))) AS addr
  FROM c JOIN public.business_events o ON c.from_group AND c.topic <> ''
   AND o.source = 'outlook-mail-capture' AND o.channel = 'email' AND o.direction = 'inbound'
   AND o.payload ->> 'sender_kind' IN ('customer', 'supplier', 'council')
   AND lower(btrim(o.payload ->> 'mailbox')) = c.mailbox
   AND public.context_email_audience_topic(o.payload ->> 'subject') = c.topic
  ORDER BY c.id, (coalesce(o.event_at, o.occurred_at) > c.at),
   abs(extract(epoch FROM coalesce(o.event_at, o.occurred_at) - c.at)), o.id
 )
 SELECT c.id, c.job_id,
  CASE WHEN cpd.id IS NOT NULL THEN 'inbox_copy' WHEN th.id IS NOT NULL THEN 'group_thread' ELSE 'unknown' END,
  CASE WHEN cpd.id IS NOT NULL AND cpd.outside IS NULL THEN 'staff.email_internal'
       WHEN cpd.id IS NOT NULL OR th.id IS NOT NULL THEN 'client.email_out'
       ELSE 'staff.email_unknown_audience' END,
  CASE WHEN cpd.id IS NOT NULL AND cpd.outside IS NULL THEN 'internal' ELSE 'outbound' END,
  CASE WHEN cpd.id IS NOT NULL THEN cpd.outside ELSE th.addr END,
  cpd.rcpt, cpd.copy_id, CASE WHEN cpd.id IS NULL THEN th.row_id END
 FROM c LEFT JOIN cpd ON cpd.id = c.id LEFT JOIN th ON th.id = c.id
$fn$;
COMMENT ON FUNCTION public.context_email_audience_plan() IS
 'Group mailbox audience (20261009131000): read only. Each stored row of our own email (outlook-mail-capture, payload.sender_kind ours) saved staff.email_internal before the rule (no payload.audience_basis) whose row cannot show its recipients (a group post, or a message with no To or Cc), with what the rule makes of it: basis inbox_copy (an old-inbox copy, inbox_events from the same sender at the same instant or within 2 minutes with the same topic, with a To line: client.email_out to its first outside address, recipients its To line; staff.email_internal when it names only our own addresses), group_thread (a group post with an outside sender, customer, supplier or council, in its thread, the same group mailbox and topic: client.email_out to the newest at or before it, else the earliest after; thread_event_id that email) or unknown (staff.email_unknown_audience, outbound, no counterpart). Service role only.';

-- 3. The relabel (or its counts).
CREATE OR REPLACE FUNCTION public.context_email_audience_backfill(p_apply boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_at timestamptz := clock_timestamp(); v_out jsonb;
BEGIN
 IF NOT coalesce(p_apply, false) THEN
  SELECT jsonb_build_object('applied', false,
    'relabel', count(*) FILTER (WHERE p.event_type <> 'staff.email_internal'),
    'confirm_internal', count(*) FILTER (WHERE p.event_type = 'staff.email_internal'),
    'inbox_copy', count(*) FILTER (WHERE p.basis = 'inbox_copy' AND p.event_type <> 'staff.email_internal'),
    'group_thread', count(*) FILTER (WHERE p.basis = 'group_thread'),
    'unknown', count(*) FILTER (WHERE p.basis = 'unknown'),
    'jobs', count(DISTINCT p.job_id) FILTER (WHERE p.event_type <> 'staff.email_internal'))
  INTO v_out FROM public.context_email_audience_plan() p;
  RETURN v_out;
 END IF;
 -- Each row once: the WHERE is read again on a row another writer (the resolver) changed first.
 WITH p AS MATERIALIZED (
  SELECT * FROM public.context_email_audience_plan()
 ), r AS (
  UPDATE public.business_events b SET
   event_type = p.event_type,
   direction = p.direction,
   payload = b.payload || jsonb_build_object('email', p.email, 'audience_basis', p.basis)
    || CASE WHEN p.recipients IS NOT NULL THEN jsonb_build_object('to', p.recipients) ELSE '{}'::jsonb END,
   metadata = coalesce(b.metadata, '{}'::jsonb) || jsonb_build_object('audience_relabel', jsonb_build_object(
    'rule', 'group_mailbox_audience_v1', 'basis', p.basis, 'at', v_at, 'by', 'context_email_audience_backfill',
    'copy_id', p.copy_id, 'thread_event_id', p.thread_event_id,
    'from', jsonb_build_object('event_type', b.event_type, 'direction', b.direction, 'email', b.payload -> 'email',
     'basis', 'before_rule'),
    'original', jsonb_build_object('event_type', b.event_type, 'direction', b.direction, 'email', b.payload -> 'email',
     'to', b.payload -> 'to', 'cc', b.payload -> 'cc', 'audience_basis', b.payload -> 'audience_basis',
     'captured_at', b.context_captured_at))),
   context_captured_at = v_at
  FROM p
  WHERE b.id = p.event_id AND p.event_type <> 'staff.email_internal'
   AND b.event_type = 'staff.email_internal' AND NOT b.payload ? 'audience_basis'
  RETURNING b.id, b.job_id, p.basis
 ), k AS (
  -- The same label on the old inbox's word: the basis is recorded, nothing else changes.
  UPDATE public.business_events b SET payload = b.payload || jsonb_build_object('audience_basis', p.basis)
  FROM p
  WHERE b.id = p.event_id AND p.event_type = 'staff.email_internal'
   AND b.event_type = 'staff.email_internal' AND NOT b.payload ? 'audience_basis'
  RETURNING b.id
 )
 SELECT jsonb_build_object('applied', true, 'at', v_at,
   'relabelled', (SELECT count(*) FROM r),
   'confirmed_internal', (SELECT count(*) FROM k),
   'inbox_copy', (SELECT count(*) FROM r WHERE r.basis = 'inbox_copy'),
   'group_thread', (SELECT count(*) FROM r WHERE r.basis = 'group_thread'),
   'unknown', (SELECT count(*) FROM r WHERE r.basis = 'unknown'),
   'jobs', (SELECT count(DISTINCT r.job_id) FROM r))
 INTO v_out;
 RETURN v_out;
END $fn$;
COMMENT ON FUNCTION public.context_email_audience_backfill(boolean) IS
 'Group mailbox audience (20261009131000): with p_apply false (the default) the counts of context_email_audience_plan() (relabel, confirm_internal, by basis, jobs), writing nothing. With true, once per row: a row the plan relabels takes its new event_type, direction, payload.email and payload.audience_basis (and payload.to, the old-inbox copy''s To line, when a copy decided), metadata.audience_relabel {rule group_mailbox_audience_v1, basis, at, by, copy_id, thread_event_id, from, original: event_type, direction, email, to, cc, audience_basis, captured_at} and context_captured_at the relabel instant, so a reading that read the old label is due again (context_ledger_judge: late_evidence or new_evidence); a row the old inbox''s copy shows went only to our own addresses keeps its label and gains payload.audience_basis inbox_copy. The party-roles trigger re-stamps each row. Answers the counts written. Service role only.';

-- 4. The reader's call when a copy of our own email meets the row another copy saved.
CREATE OR REPLACE FUNCTION public.context_email_audience_resolve(p_row jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
 k text; n_type text; n_dir text; n_email text; n_folder text; n_to jsonb; n_cc jsonb; nb text; sb text;
 rn integer; rs integer; e public.business_events; v_at timestamptz := clock_timestamp();
BEGIN
 IF p_row IS NULL OR jsonb_typeof(p_row) IS DISTINCT FROM 'object' OR jsonb_typeof(p_row -> 'payload') IS DISTINCT FROM 'object' THEN
  RETURN jsonb_build_object('outcome', 'refused', 'code', 'audience_row_invalid');
 END IF;
 k := nullif(btrim(p_row ->> 'provider_message_id'), '');
 n_type := p_row ->> 'event_type';
 n_dir := p_row ->> 'direction';
 n_email := lower(nullif(btrim(p_row #>> '{payload,email}'), ''));
 n_folder := p_row #>> '{payload,folder_kind}';
 n_to := CASE WHEN jsonb_typeof(p_row #> '{payload,to}') = 'array' THEN p_row #> '{payload,to}' ELSE '[]'::jsonb END;
 n_cc := CASE WHEN jsonb_typeof(p_row #> '{payload,cc}') = 'array' THEN p_row #> '{payload,cc}' ELSE '[]'::jsonb END;
 -- This copy's basis: what the reader read for a group post, or a mailbox copy's own recipients.
 nb := CASE WHEN n_folder = 'group' THEN
             CASE WHEN p_row #>> '{payload,audience_basis}' IN ('group_thread', 'unknown') THEN p_row #>> '{payload,audience_basis}' END
            WHEN n_folder IN ('inbox', 'sent', 'deleted', 'other') AND NOT (p_row -> 'payload') ? 'audience_basis'
             AND jsonb_array_length(n_to) + jsonb_array_length(n_cc) > 0 THEN 'mailbox_copy' END;
 IF k IS NULL OR k !~ '^email:' OR p_row ->> 'source' IS DISTINCT FROM 'outlook-mail-capture'
  OR p_row ->> 'channel' IS DISTINCT FROM 'email' OR p_row #>> '{payload,sender_kind}' IS DISTINCT FROM 'ours' OR nb IS NULL
  OR NOT coalesce((n_type = 'client.email_out' AND n_dir = 'outbound' AND n_email IS NOT NULL AND nb IN ('mailbox_copy', 'group_thread'))
   OR (n_type = 'staff.email_internal' AND n_dir = 'internal' AND n_email IS NULL AND nb = 'mailbox_copy')
   OR (n_type = 'staff.email_unknown_audience' AND n_dir = 'outbound' AND n_email IS NULL AND nb = 'unknown'), false) THEN
  RETURN jsonb_build_object('outcome', 'refused', 'code', 'audience_row_invalid');
 END IF;
 IF NOT public.automation_lane_enabled('capture') THEN RETURN jsonb_build_object('outcome', 'capture_disabled'); END IF;
 SELECT * INTO e FROM public.business_events WHERE provider_message_id = k FOR UPDATE;
 IF e.id IS NULL THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
 IF e.source IS DISTINCT FROM 'outlook-mail-capture' OR e.channel IS DISTINCT FROM 'email'
  OR e.payload ->> 'sender_kind' IS DISTINCT FROM 'ours' THEN
  RETURN jsonb_build_object('outcome', 'unchanged', 'id', e.id, 'basis', 'not_our_email');
 END IF;
 -- The saved row's basis; one saved internal before the rule, from a group or with no
 -- recipients, is the weakest.
 sb := CASE WHEN e.payload ->> 'audience_basis' IN ('unknown', 'group_thread', 'inbox_copy', 'mailbox_copy') THEN e.payload ->> 'audience_basis'
            WHEN e.event_type = 'staff.email_internal' AND (e.payload ->> 'folder_kind' = 'group'
             OR (jsonb_array_length(CASE WHEN jsonb_typeof(e.payload -> 'to') = 'array' THEN e.payload -> 'to' ELSE '[]'::jsonb END) = 0
              AND jsonb_array_length(CASE WHEN jsonb_typeof(e.payload -> 'cc') = 'array' THEN e.payload -> 'cc' ELSE '[]'::jsonb END) = 0))
             THEN 'before_rule'
            ELSE 'recipients' END;
 rn := CASE nb WHEN 'unknown' THEN 1 WHEN 'group_thread' THEN 2 ELSE 4 END;
 rs := CASE sb WHEN 'before_rule' THEN 0 WHEN 'unknown' THEN 1 WHEN 'group_thread' THEN 2 WHEN 'inbox_copy' THEN 3 ELSE 4 END;
 IF rn <= rs THEN RETURN jsonb_build_object('outcome', 'unchanged', 'id', e.id, 'basis', sb); END IF;
 IF e.event_type = n_type AND e.direction IS NOT DISTINCT FROM n_dir
  AND lower(nullif(btrim(e.payload ->> 'email'), '')) IS NOT DISTINCT FROM n_email THEN
  -- The same label on a stronger basis: recorded, so a weaker copy read later never moves it.
  UPDATE public.business_events SET payload = payload || jsonb_build_object('audience_basis', nb) WHERE id = e.id;
  RETURN jsonb_build_object('outcome', 'confirmed', 'id', e.id, 'basis', nb, 'from_basis', sb);
 END IF;
 UPDATE public.business_events b SET
  event_type = n_type,
  direction = n_dir,
  payload = b.payload || jsonb_build_object('email', n_email, 'audience_basis', nb)
   || CASE WHEN nb = 'mailbox_copy' THEN jsonb_build_object('to', n_to, 'cc', n_cc, 'recipients_from', p_row #>> '{payload,mailbox}')
      ELSE '{}'::jsonb END,
  metadata = coalesce(b.metadata, '{}'::jsonb) || jsonb_build_object('audience_relabel', jsonb_build_object(
   'rule', 'group_mailbox_audience_v1', 'basis', nb, 'at', v_at, 'by', 'context_email_audience_resolve',
   'from', jsonb_build_object('event_type', b.event_type, 'direction', b.direction, 'email', b.payload -> 'email', 'basis', sb),
   'original', coalesce(b.metadata #> '{audience_relabel,original}',
    jsonb_build_object('event_type', b.event_type, 'direction', b.direction, 'email', b.payload -> 'email',
     'to', b.payload -> 'to', 'cc', b.payload -> 'cc', 'audience_basis', b.payload -> 'audience_basis',
     'captured_at', b.context_captured_at)))),
  context_captured_at = v_at
 WHERE b.id = e.id;
 RETURN jsonb_build_object('outcome', 'relabelled', 'id', e.id, 'basis', nb, 'from_basis', sb);
END $fn$;
COMMENT ON FUNCTION public.context_email_audience_resolve(jsonb) IS
 'Group mailbox audience (20261009131000): the email reader''s call when a copy of our own email meets the row another copy saved under the same key. p_row is that copy''s row as outlook_mail.ts built it: source outlook-mail-capture, channel email, an email: key, payload.sender_kind ours, and a label that matches its basis (a group post: group_thread client.email_out to its thread party, or unknown staff.email_unknown_audience with no counterpart; a mailbox copy listing its recipients: mailbox_copy, client.email_out to its first outside recipient or staff.email_internal); anything else is refused (audience_row_invalid). Nothing while the capture lane is off (capture_disabled). The saved row, of our own email from this reader, is relabelled only when the copy''s basis is stronger (its own or a mailbox copy''s recipients, then the old inbox''s copy, then the thread, then unknown; a row saved internal before the rule is weakest) and its label (event_type, direction, payload.email) differs: it takes the copy''s label and basis (a mailbox copy''s To and Cc too, with recipients_from), metadata.audience_relabel (from, and original kept from the first relabel) and context_captured_at the relabel instant, so a reading that read the old label is due again; the same label on a stronger basis records the basis alone (confirmed); otherwise unchanged. The party-roles trigger re-stamps the row. Service role only.';

-- 5. Access: service role only.
REVOKE ALL ON FUNCTION public.context_email_audience_topic(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_email_audience_plan() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_email_audience_backfill(boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_email_audience_resolve(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_email_audience_topic(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_email_audience_plan() TO service_role;
GRANT EXECUTE ON FUNCTION public.context_email_audience_backfill(boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_email_audience_resolve(jsonb) TO service_role;

-- 6. The relabel, once. A second apply finds nothing left to take (every row it took carries
-- payload.audience_basis).
SELECT public.context_email_audience_backfill(true);
