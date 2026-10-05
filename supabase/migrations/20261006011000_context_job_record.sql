-- The job record layer: timeline, loops, money and contact from records only
-- (story slice S1, 6 Oct 2026).
--
-- Why. The owner wants to open any job and see its whole story: where it sits,
-- what is owed, who has to move next and why (done-definition rows 11 and 12).
-- Three reviews agreed the story starts from records that need no model: the
-- quote, invoice, payment, booking and status rows the business already keeps
-- (data/cio-ctx-story-compare/report.md section 4). This migration computes
-- that layer at read time. It stores nothing and writes nothing.
--
--   context_job_record_messages(job_ids, as_of)  helper (inlinable): every
--        message-shaped business_events row on the jobs, with the who-to-whom
--        labels the rules need, plus legacy inbox_events mail on the job or from
--        the client's own address that has no business_events copy.
--   context_job_record_timeline(job_ids, as_of)  one row per record milestone,
--        oldest first: job created, first contact, site visit, every quote
--        version event with its value, status changes (ping-pong within 10
--        minutes folded into one row), invoices, payments, credits, supplier
--        bills and what we paid on them, system emails, bookings (observer
--        mirrors kept apart as booking_mirror), booking changes, attendance,
--        variations, purchase and work orders, rectification, make-safe
--        milestones, tasks, staff notes (their words) and documents read (file
--        name only).
--   context_job_record_loops(job_ids, as_of)  record-closable loops:
--        R1 to R8 are exactly the proof-set reference rules (tests.md T2, as
--        implemented by grade_ref.py record_loops(); that code is the
--        tie-breaker), M1 money due, and checks C1 to C11 (a person's look,
--        never an obligation). R5 and C11 are candidates: the story shows them
--        as loops only when the ledger confirms a reply is owed.
--   context_job_record_money(job_ids, as_of)  money per paying party from
--        Xero: invoiced, paid (raw Payments), credited (credit notes and
--        overpayments applied), owing, overdue, drafts, each invoice, the job
--        value and what is not yet invoiced, and supplier bills (money we owe).
--   context_job_record_contact(job_ids, as_of)  last customer message, last
--        we told the customer, last internal message, last calls each way and
--        reply statistics. Crew and staff texts are internal; automated texts
--        never count as a reply; supplier, engineer and contractor mail is never
--        the customer.
--
-- Replay (p_as_of): rows recorded after it are ignored (business_events by
-- recorded time, other tables by created time, quote and booking stamps that
-- fall after it are read as not yet set). Mutable record rows (invoice status
-- and amounts, booking status, job status and value) are read as they are now;
-- a replay is therefore exact only for the append-only parts.
--
-- Time is coalesce(event_at, occurred_at) for business_events. Dates in words
-- are Perth dates written like "Wed 7 Oct". No em dashes in any text.
-- Unchanged: every existing table, function and reader. Two indexes are added
-- on inbox_events (section 1a). Nothing calls these functions until the story
-- (20261006014000) and the ops-api read doors do.
-- Rollback: supabase/rollbacks/20261006011000_context_job_record_down.sql
-- (drops the five functions and the two indexes; nothing else depends on them
-- except the story, whose rollback runs first).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Guard: every table and helper the bodies read must exist, and each of the
-- five functions must be absent or this migration's (re-apply is a no-op).
DO $guard$
DECLARE problems text[] := '{}'; t text; f text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.jobs','public.business_events','public.inbox_events','public.xero_invoices',
   'public.job_documents','public.job_assignments','public.job_events','public.email_events','public.visit_outcomes',
   'public.job_variations','public.purchase_orders','public.work_orders'] LOOP
  IF to_regclass(t) IS NULL THEN problems := problems || format('%s is missing', t); END IF;
 END LOOP;
 IF to_regprocedure('public.context_event_text(public.business_events)') IS NULL THEN
  problems := problems || 'public.context_event_text(business_events) is missing'::text;
 END IF;
 IF to_regprocedure('public.context_internal_text_role(public.business_events)') IS NULL THEN
  problems := problems || 'public.context_internal_text_role(business_events) is missing'::text;
 END IF;
 IF to_regprocedure('public.job_quote_values(uuid)') IS NULL THEN
  problems := problems || 'public.job_quote_values(uuid) is missing'::text;
 END IF;
 FOREACH f IN ARRAY ARRAY['public.context_job_record_messages(uuid[],timestamptz)',
   'public.context_job_record_legacy_mail(uuid[],timestamptz)','public.context_job_record_date(text)',
   'public.context_job_record_timeline(uuid[],timestamptz)','public.context_job_record_loops(uuid[],timestamptz)',
   'public.context_job_record_money(uuid[],timestamptz)','public.context_job_record_contact(uuid[],timestamptz)'] LOOP
  IF to_regprocedure(f) IS NOT NULL AND coalesce(obj_description(to_regprocedure(f), 'pg_proc'), '')
     NOT LIKE 'Job record (20261006011000)%' THEN
   problems := problems || format('%s exists and is not this migration''s', f);
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_job_record_preimage_mismatch: %', array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1a. Two indexes on inbox_events (13.7k rows live, none on these columns): the
-- legacy-mail read finds a job's mail by job_id and the client's mail by sender.
-- Without them every story read scans the table twice (about 48 ms of a 53 ms
-- message read, measured read-only on production). Built-in expressions only.
CREATE INDEX IF NOT EXISTS inbox_events_job_id_record ON public.inbox_events (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbox_events_from_email_record ON public.inbox_events (lower(btrim(from_email)));

-- 1c. A date written in a payload or app event: a real yyyy-mm-dd (a time may
-- follow), else null. One bad row never fails a story. Inlinable (no SET).
CREATE OR REPLACE FUNCTION public.context_job_record_date(p text) RETURNS date
LANGUAGE sql IMMUTABLE AS $fn$
 SELECT CASE WHEN p OPERATOR(pg_catalog.~) '^(19|2[0-9])[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])([T ].*)?$'
   AND pg_catalog.substr(p, 9, 2)::integer OPERATOR(pg_catalog.<=) pg_catalog.date_part('day',
    pg_catalog.make_date(pg_catalog.substr(p, 1, 4)::integer, pg_catalog.substr(p, 6, 2)::integer, 1)
     OPERATOR(pg_catalog.+) interval '1 month' OPERATOR(pg_catalog.-) interval '1 day')
  THEN pg_catalog.substr(p, 1, 10)::date END
$fn$;
COMMENT ON FUNCTION public.context_job_record_date(text) IS
 'Job record (20261006011000): a payload or app-event date read safely: a real calendar yyyy-mm-dd (a time may follow), else null, so one bad row never fails a story. Inlinable helper. Service role only.';

-- 1b. Legacy mail helper (inlinable): inbox_events mail on the job, or from the
-- client's own address, with no business_events copy anywhere (the copy, where
-- it exists, is placed by the ladder and is what counts) and no business_events
-- email on the job at the same instant; one row per received instant (the old
-- path saved one copy per mailbox); auto-replies dropped. The messages helper
-- and the story's evidence lanes both read it, so the rule lives once.
-- Mail from the client's address that the old matcher placed on no job:
--   - when the client has another job (the same CRM contact or the same client
--     email) it may be that job's, so it is withheld (placement withheld):
--     counted for the story, never a message of this job;
--   - otherwise it is this job's from 30 days before the job was created
--     (placement not_placed, labelled where shown); older mail is left out.
-- The ledger store's evidence and citation check keep the same rule.
CREATE OR REPLACE FUNCTION public.context_job_record_legacy_mail(p_job_ids uuid[], p_as_of timestamptz DEFAULT now())
RETURNS TABLE(jid uuid, cmail text, id uuid, received_at timestamptz, subject text, body_preview text, from_email text,
 graph_message_id text, on_job boolean, placement text)
LANGUAGE sql STABLE
AS $fn$
 WITH j AS (
  SELECT jb.id, lower(nullif(btrim(jb.client_email), '')) AS cmail, jb.created_at,
         -- (two lookups, each on its own jobs index: the CRM contact, the client email)
         (EXISTS (SELECT 1 FROM public.jobs o WHERE o.ghl_contact_id = nullif(btrim(jb.ghl_contact_id), '') AND o.id <> jb.id)
          OR EXISTS (SELECT 1 FROM public.jobs o WHERE o.client_email IS NOT NULL
                     AND lower(btrim(o.client_email)) = lower(nullif(btrim(jb.client_email), '')) AND o.id <> jb.id)) AS repeat_client
  FROM public.jobs jb WHERE jb.id = ANY (p_job_ids)
 ),
 ibx AS (
  SELECT j.id AS jid, j.cmail, i.id, i.received_at, i.subject, i.body_preview, i.from_email, i.graph_message_id,
         (i.job_id = j.id) AS on_job, 'on_job'::text AS placement
  FROM j JOIN public.inbox_events i ON i.job_id = j.id
  UNION ALL
  SELECT j.id, j.cmail, i.id, i.received_at, i.subject, i.body_preview, i.from_email, i.graph_message_id, false,
         CASE WHEN j.repeat_client THEN 'withheld' ELSE 'not_placed' END
  FROM j JOIN public.inbox_events i ON lower(btrim(i.from_email)) = j.cmail
  -- from the client's address only when placed on no job: mail the old matcher
  -- placed on another job stays there (a repeat customer's other jobs)
  WHERE j.cmail IS NOT NULL AND i.job_id IS NULL
    AND (j.repeat_client OR i.received_at >= j.created_at - interval '30 days')
 )
 SELECT DISTINCT ON (x.jid, x.received_at) x.jid, x.cmail, x.id, x.received_at, x.subject, x.body_preview, x.from_email,
        x.graph_message_id, x.on_job, x.placement
 FROM ibx x
 WHERE x.received_at <= p_as_of
   AND coalesce(x.subject, '') !~* '^(automatic reply|auto[- ]?reply|out of office)'
   AND NOT EXISTS (SELECT 1 FROM public.business_events c
                   WHERE c.source_table = 'inbox_events' AND c.source_id = x.id::text)
   AND NOT EXISTS (SELECT 1 FROM public.business_events c
                   WHERE x.graph_message_id IS NOT NULL AND c.provider_message_id = 'graph:' || x.graph_message_id)
   AND NOT EXISTS (SELECT 1 FROM public.business_events c
                   WHERE c.payload @> jsonb_build_object('inbox_events_id', x.id::text))
   AND NOT EXISTS (SELECT 1 FROM public.business_events m
                   WHERE m.job_id = x.jid AND m.channel = 'email' AND coalesce(m.event_at, m.occurred_at) = x.received_at
                     AND coalesce(m.recorded_at, m.occurred_at) <= p_as_of)
 ORDER BY x.jid, x.received_at, x.on_job DESC, x.id
$fn$;
COMMENT ON FUNCTION public.context_job_record_legacy_mail(uuid[], timestamptz) IS
 'Job record (20261006011000): legacy inbox_events mail for the jobs: placed on the job (placement on_job), or from the client address and placed on no job (mail placed on another job stays there): withheld when the client has another job (same CRM contact or client email), else not_placed from 30 days before the job was created; no business_events copy, no business_events email on the job at the same instant, one row per received instant, auto-replies dropped. Inlinable helper read by context_job_record_messages (withheld rows never) and the story. Service role only.';

-- 1. Messages helper. Inlinable on purpose (LANGUAGE sql, STABLE, no SET, not
-- SECURITY DEFINER): the four record functions below call it inside their own
-- SECURITY DEFINER bodies, where the planner folds it in. Every name is
-- schema-qualified. Service role only.
--
-- Labels follow the proof-set reference exactly (grade_ref.py,
-- is_customer_counterpart): a row with metadata.recipient_role is never
-- customer-facing; else the party_roles counterpart decides; else the row's
-- contact is the job's GHL contact, or the job's client email is on the from or
-- to side of an email.
CREATE OR REPLACE FUNCTION public.context_job_record_messages(p_job_ids uuid[], p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, source_table text, source_id text, at timestamptz, event_type text, source text,
 channel text, direction text, words text, counterpart_role text, sender_role text, audience text,
 recipient_role text, is_job_contact boolean, from_is_client boolean, to_is_client boolean, sent_by_kind text,
 internal_role text, is_msg boolean, is_note boolean, customer_side boolean, internal boolean, automated boolean,
 bad_call boolean, call_answered boolean, placement text)
LANGUAGE sql STABLE
AS $fn$
 WITH j AS (
  SELECT jb.id, lower(nullif(btrim(jb.client_email), '')) AS cmail, nullif(btrim(jb.ghl_contact_id), '') AS ccontact
  FROM public.jobs jb WHERE jb.id = ANY (p_job_ids)
 ),
 ev AS (
  SELECT j.id AS jid, j.cmail, j.ccontact, e.id, coalesce(e.event_at, e.occurred_at) AS at, e.event_type, e.source,
         e.channel, e.direction, e.contact_id, e.payload, e.metadata,
         regexp_replace(public.context_event_text(e), '\s+', ' ', 'g') AS txt,
         -- crew and staff alerts are texts we send; inbound rows are never one
         CASE WHEN e.direction = 'outbound' THEN public.context_internal_text_role(e) ELSE 'other' END AS irole,
         (e.channel IN ('sms', 'email', 'call')
          OR e.event_type IN ('client.sms_out', 'client.email_out', 'client.call_logged', 'client.call_complete',
                              'call.transcript_completed', 'client.reply', 'client.email_in', 'client.sms_in')) AS is_msg,
         (e.event_type IN ('note.added', 'ghl.internal_comment') OR e.channel = 'note') AS is_note
  FROM j JOIN public.business_events e ON e.job_id = j.id
  WHERE coalesce(e.recorded_at, e.occurred_at) <= p_as_of
    AND (e.channel IN ('sms', 'email', 'call', 'note')
         OR e.event_type IN ('client.sms_out', 'client.email_out', 'client.call_logged', 'client.call_complete',
                             'call.transcript_completed', 'client.reply', 'client.email_in', 'client.sms_in',
                             'note.added', 'ghl.internal_comment'))
 ),
 lab AS (
  SELECT ev.*,
         nullif(ev.metadata->'party_roles'->>'counterpart_role', '') AS cp,
         nullif(ev.metadata->'party_roles'->>'sender_role', '') AS sr,
         coalesce(nullif(ev.metadata->'party_roles'->>'audience', ''), nullif(ev.metadata->>'audience', '')) AS aud,
         nullif(ev.metadata->>'recipient_role', '') AS rr,
         CASE WHEN ev.contact_id IS NULL OR ev.ccontact IS NULL THEN NULL ELSE ev.contact_id::text = ev.ccontact END AS ijc,
         CASE WHEN ev.cmail IS NULL OR ev.channel IS DISTINCT FROM 'email' THEN NULL
              ELSE position(ev.cmail IN lower(concat_ws(' ', ev.payload->>'from', ev.payload->>'from_email',
                                                       ev.payload->>'sender'))) > 0 END AS fic,
         CASE WHEN ev.cmail IS NULL OR ev.channel IS DISTINCT FROM 'email' THEN NULL
              ELSE position(ev.cmail IN lower(concat_ws(' ', ev.payload->>'to', ev.payload->>'to_email',
                   (ev.payload->'recipients')::text, (ev.payload->'to_recipients')::text, (ev.payload->'cc')::text))) > 0
         END AS tic,
         nullif(ev.payload->>'sent_by_kind', '') AS sbk
  FROM ev
 ),
 bel AS (
  SELECT l.jid, 'business_events'::text AS tbl, l.id::text AS sid, l.at, l.event_type, l.source, l.channel, l.direction,
         left(l.txt, 300) AS words, l.cp, l.sr, l.aud, l.rr, l.ijc, l.fic, l.tic, l.sbk, l.irole, l.is_msg, l.is_note,
         (l.is_msg AND CASE WHEN l.rr IS NOT NULL THEN false
                            WHEN l.cp IS NOT NULL THEN l.cp = 'customer'
                            ELSE coalesce(l.ijc, false) OR coalesce(l.fic, false) OR coalesce(l.tic, false) END) AS cust,
         (l.rr IN ('crew', 'staff') OR l.aud = 'internal' OR l.irole <> 'other' OR l.cp IN ('crew', 'staff')
          OR (l.is_msg AND l.direction = 'internal')) AS internal,
         (l.sbk = 'workflow' OR l.irole <> 'other') AS automated,
         (l.direction = 'inbound' AND l.channel = 'call'
          AND l.txt ~* 'Provider status: (no-answer|ringing|busy|missed|voicemail|canceled|cancelled)') AS bad_call,
         ((l.channel = 'call' OR l.event_type IN ('client.call_logged', 'client.call_complete', 'call.transcript_completed'))
          AND (l.event_type = 'call.transcript_completed'
               OR lower(coalesce(l.payload->>'call_status', substring(l.txt FROM 'Provider status: ([A-Za-z_-]+)'), ''))
                  IN ('completed', 'answered'))) AS answered,
         'on_job'::text AS placement
  FROM lab l
 ),
 -- legacy mail: a repeat client's mail placed on no job is withheld (it may be another job's)
 ib AS (SELECT * FROM public.context_job_record_legacy_mail(p_job_ids, p_as_of) x WHERE x.placement <> 'withheld'),
 ibl AS (
  SELECT ib.jid, 'inbox_events'::text AS tbl, ib.id::text AS sid, ib.received_at AS at, 'inbox.email'::text AS event_type,
         'monitor-inbox legacy'::text AS source, 'email'::text AS channel,
         CASE WHEN lower(coalesce(substring(ib.from_email FROM '@([A-Za-z0-9.-]+)'), ''))
                   ~ '(^|\.)(secureworksgroup\.com\.au|secureworksgroup\.app|secureworkswa\.com\.au)$'
              THEN 'internal' ELSE 'inbound' END AS direction,
         left(regexp_replace(coalesce(ib.subject || ' | ', '') || coalesce(ib.body_preview, ''), '\s+', ' ', 'g'), 300) AS words,
         CASE WHEN ib.cmail IS NOT NULL AND lower(btrim(ib.from_email)) = ib.cmail THEN 'customer' END AS cp,
         CASE WHEN ib.cmail IS NOT NULL AND lower(btrim(ib.from_email)) = ib.cmail THEN 'customer' END AS sr,
         NULL::text AS aud, NULL::text AS rr, NULL::boolean AS ijc,
         CASE WHEN ib.cmail IS NULL THEN NULL ELSE lower(btrim(ib.from_email)) = ib.cmail END AS fic,
         NULL::boolean AS tic, NULL::text AS sbk, 'other'::text AS irole, true AS is_msg, false AS is_note,
         (ib.cmail IS NOT NULL AND lower(btrim(ib.from_email)) = ib.cmail) AS cust,
         false AS internal, false AS automated, false AS bad_call, false AS answered,
         ib.placement
  FROM ib
 )
 SELECT u.jid AS job_id, u.tbl AS source_table, u.sid AS source_id, u.at, u.event_type, u.source, u.channel, u.direction,
        u.words, u.cp AS counterpart_role, u.sr AS sender_role, u.aud AS audience, u.rr AS recipient_role,
        u.ijc AS is_job_contact, u.fic AS from_is_client, u.tic AS to_is_client, u.sbk AS sent_by_kind,
        u.irole AS internal_role, u.is_msg, u.is_note, u.cust AS customer_side, coalesce(u.internal, false) AS internal,
        coalesce(u.automated, false) AS automated, coalesce(u.bad_call, false) AS bad_call,
        coalesce(u.answered, false) AS call_answered, u.placement
 FROM (SELECT * FROM bel UNION ALL SELECT * FROM ibl) u
$fn$;
COMMENT ON FUNCTION public.context_job_record_messages(uuid[], timestamptz) IS
 'Job record (20261006011000): message-shaped business_events on the jobs (recorded at or before p_as_of) with the who-to-whom labels of the proof-set reference (customer_side = grade_ref is_customer_counterpart), plus legacy inbox_events mail placed on the job, or from the client address and placed on no job (placement not_placed), with no business_events copy. Inlinable helper (no SET, not SECURITY DEFINER) read by the job record functions. Service role only.';

-- 2. Timeline: one row per record milestone, oldest first.
CREATE OR REPLACE FUNCTION public.context_job_record_timeline(p_job_ids uuid[], p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, at timestamptz, perth_date date, time_basis text, kind text, what text, amount numeric,
 party text, placement text, source_table text, source_id text, state text, made_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH j AS (
  SELECT jb.id, jb.status::text AS status, jb.type::text AS type, jb.created_at, jb.quoted_at, jb.accepted_at,
         jb.approvals_at, jb.processing_at, jb.scheduled_at, jb.completed_at, jb.deposit_at, jb.deposit_amount
  FROM public.jobs jb WHERE jb.id = ANY (p_job_ids)
 ),
 msg AS (SELECT * FROM public.context_job_record_messages(p_job_ids, p_as_of)),
 -- status changes from the app timeline and from the status events, folded:
 -- rows less than 10 minutes apart become one row showing the path
 st0 AS (
  SELECT je.job_id, je.created_at AS at,
         coalesce(je.detail_json->>'new_status', je.detail_json->>'to', je.detail_json->>'status') AS to_s,
         coalesce(je.detail_json->>'old_status', je.detail_json->>'from') AS from_s,
         'job_events'::text AS tbl, je.id::text AS sid
  FROM public.job_events je
  WHERE je.job_id = ANY (p_job_ids) AND je.event_type IN ('status_changed', 'status_change') AND je.created_at <= p_as_of
  UNION ALL
  SELECT e.job_id, coalesce(e.event_at, e.occurred_at), e.payload->'changes'->'status'->>'to',
         e.payload->'changes'->'status'->>'from', 'business_events', e.id::text
  FROM public.business_events e
  WHERE e.job_id = ANY (p_job_ids) AND e.event_type = 'job.status_changed'
    AND coalesce(e.recorded_at, e.occurred_at) <= p_as_of
 ),
 st1 AS (
  SELECT s.*, CASE WHEN lag(s.at) OVER w IS NULL OR s.at - lag(s.at) OVER w >= interval '10 minutes' THEN 1 ELSE 0 END AS brk
  FROM st0 s WHERE s.to_s IS NOT NULL AND s.at IS NOT NULL
  WINDOW w AS (PARTITION BY s.job_id ORDER BY s.at, s.sid)
 ),
 st2 AS (SELECT s.*, sum(s.brk) OVER (PARTITION BY s.job_id ORDER BY s.at, s.sid) AS grp FROM st1 s),
 st3 AS (SELECT s.*, lag(s.to_s) OVER (PARTITION BY s.job_id, s.grp ORDER BY s.at, s.sid) AS prev_to FROM st2 s),
 stg AS (
  SELECT s.job_id, s.grp, count(*) AS n, min(s.at) AS first_at, max(s.at) AS last_at,
         (array_agg(s.from_s ORDER BY s.at, s.sid) FILTER (WHERE s.from_s IS NOT NULL))[1] AS from_s,
         string_agg(replace(s.to_s, '_', ' '), ' -> ' ORDER BY s.at, s.sid) FILTER (WHERE s.prev_to IS DISTINCT FROM s.to_s) AS path,
         count(*) FILTER (WHERE s.prev_to IS DISTINCT FROM s.to_s) AS steps,
         (array_agg(s.to_s ORDER BY s.at DESC, s.sid DESC))[1] AS final_to,
         (array_agg(s.tbl ORDER BY s.at DESC, s.sid DESC))[1] AS tbl,
         (array_agg(s.sid ORDER BY s.at DESC, s.sid DESC))[1] AS sid
  FROM st3 s GROUP BY s.job_id, s.grp
 ),
 inv AS (
  SELECT x.id, x.job_id, x.invoice_number, x.reference, x.contact_name, x.total, x.amount_due, x.amount_paid,
         x.invoice_date, x.due_date, x.fully_paid_on, x.raw_json, x.created_at,
         upper(coalesce(x.status, '')) AS st, upper(coalesce(x.invoice_type, 'ACCREC')) AS itype
  FROM public.xero_invoices x
  WHERE x.job_id = ANY (p_job_ids) AND coalesce(x.created_at, x.synced_at, '-infinity'::timestamptz) <= p_as_of
 ),
 qv AS (
  SELECT j.id AS job_id, v.document_id, v.value_inc_gst, v.value_source
  FROM j CROSS JOIN LATERAL public.job_quote_values(j.id) v
 ),
 asg AS (
  SELECT a.*, coalesce(a.is_ghost, false) OR coalesce(a.role, '') = 'observer' AS mirror
  FROM public.job_assignments a
  WHERE a.job_id = ANY (p_job_ids) AND a.created_at <= p_as_of
 ),
 m AS (
  -- job created
  SELECT j.id AS job_id, j.created_at AS at, 'observed'::text AS time_basis, 'job_created'::text AS kind,
         'Job created (' || coalesce(j.type, 'type not set') || ')' AS what, NULL::numeric AS amount, NULL::text AS party,
         'on_job'::text AS placement, 'jobs'::text AS source_table, j.id::text AS source_id
  FROM j WHERE j.created_at <= p_as_of
  -- stage stamps on the job row, unless a status row already shows that stage
  UNION ALL
  SELECT j.id, s.at, 'stamp', 'status',
         'Job record stamp: entered ' || replace(s.stage, '_', ' ') || ' (the job row keeps only the last time it entered this stage)',
         CASE WHEN s.stage = 'deposit' THEN j.deposit_amount END, NULL, 'on_job', 'jobs', j.id::text
  FROM j CROSS JOIN LATERAL (VALUES ('quoted', j.quoted_at), ('accepted', j.accepted_at), ('approvals', j.approvals_at),
       ('processing', j.processing_at), ('scheduled', j.scheduled_at), ('complete', j.completed_at),
       ('deposit', j.deposit_at)) s(stage, at)
  WHERE s.at IS NOT NULL AND s.at <= p_as_of
    AND NOT EXISTS (SELECT 1 FROM st0 x WHERE x.job_id = j.id
                    AND (x.to_s = s.stage OR (s.stage = 'complete' AND x.to_s IN ('completed', 'complete')))
                    AND abs(extract(epoch FROM x.at - s.at)) < 3600)
  -- status changes
  UNION ALL
  SELECT g.job_id, g.last_at, 'observed',
         CASE WHEN g.final_to = 'rectification' THEN 'rectification' ELSE 'status' END,
         CASE WHEN g.steps <= 1 THEN 'Status set to ' || replace(g.final_to, '_', ' ')
                   || coalesce(' (from ' || replace(g.from_s, '_', ' ') || ')', '')
              ELSE 'Status changed ' || g.steps || ' times within minutes: ' || g.path
                   || '; it ended at ' || replace(g.final_to, '_', ' ') END,
         NULL, NULL, 'on_job', g.tbl, g.sid
  FROM stg g
  -- first message with the customer (texts, emails, calls, legacy mail)
  UNION ALL
  SELECT * FROM (
   SELECT DISTINCT ON (c.job_id) c.job_id, c.at, 'observed', 'first_contact',
          'First message with the customer on record (' || coalesce(c.channel, c.event_type) || ', '
            || CASE WHEN c.direction = 'inbound' THEN 'from the customer' ELSE 'from us' END
            || CASE WHEN c.placement = 'not_placed' THEN ', not placed on any job' ELSE '' END || ')',
          NULL::numeric, NULL::text, c.placement, c.source_table, c.source_id
   FROM msg c WHERE c.customer_side
   ORDER BY c.job_id, c.at, c.source_id) fc
  -- site visits: CRM appointments, recorded visit outcomes, scope first saved
  UNION ALL
  SELECT e.job_id, coalesce(e.event_at, e.occurred_at), 'observed', 'site_visit',
         'Appointment ' || replace(coalesce(e.payload->>'appointment_action', e.event_type), '_', ' ')
           || coalesce(': ' || left(e.payload->>'title', 120), '')
           || coalesce(', status ' || (e.payload->>'appointment_status'), ''),
         NULL, NULL, 'on_job', 'business_events', e.id::text
  FROM public.business_events e
  WHERE e.job_id = ANY (p_job_ids) AND coalesce(e.recorded_at, e.occurred_at) <= p_as_of
    AND e.event_type IN ('ghl.appointment_created', 'ghl.appointment_updated', 'ghl.appointment_deleted', 'client.appointment')
  UNION ALL
  SELECT j.id, o.visit_start, 'observed', 'site_visit',
         'Visit outcome recorded: ' || replace(coalesce(o.outcome, '?'), '_', ' ') || coalesce(' (' || o.reason || ')', '')
           || CASE WHEN o.quote_owed THEN '; a quote is owed' ELSE '' END,
         NULL, NULL, CASE WHEN o.job_id = j.id THEN 'on_job' ELSE 'contact' END, 'visit_outcomes', o.id::text
  FROM j JOIN public.jobs jj ON jj.id = j.id
  JOIN public.visit_outcomes o
    ON o.job_id = j.id OR (o.job_id IS NULL AND o.contact_id = nullif(btrim(jj.ghl_contact_id), ''))
  WHERE o.recorded_at <= p_as_of AND NOT EXISTS (SELECT 1 FROM public.visit_outcomes s WHERE s.supersedes = o.id)
  UNION ALL
  SELECT * FROM (
   SELECT DISTINCT ON (je.job_id) je.job_id, je.created_at, 'observed', 'site_visit',
          'Scope first saved in the scoping tool', NULL::numeric, NULL::text, 'on_job', 'job_events', je.id::text
   FROM public.job_events je
   WHERE je.job_id = ANY (p_job_ids) AND je.event_type = 'scope_saved' AND je.created_at <= p_as_of
   ORDER BY je.job_id, je.created_at, je.id) ss
  -- quotes: one row per version event; generated is folded into sent when both
  -- happened on the same Perth day within an hour
  UNION ALL
  SELECT d.job_id, q.at, 'observed', 'quote',
         CASE WHEN d.type = 'quote' THEN 'Quote ' ELSE initcap(replace(d.type, '_', ' ')) || ' ' END
           || coalesce(d.quote_number, 'without a number') || coalesce(' v' || d.version, '')
           || coalesce(' (' || d.run_label || ')', '') || ' ' || q.ev
           || CASE WHEN q.ev = 'sent' THEN coalesce(', value ' || to_char(v.value_inc_gst, 'FM$999,999,990.00') || ' inc GST',
                                                    ', value not recorded (' || coalesce(v.value_source, 'not a sent quote') || ')')
                   WHEN q.ev = 'accepted' THEN coalesce(', value ' || to_char(v.value_inc_gst, 'FM$999,999,990.00') || ' inc GST', '')
                   ELSE '' END,
         CASE WHEN q.ev IN ('sent', 'accepted') THEN v.value_inc_gst END, NULL, 'on_job', 'job_documents', d.id::text
  FROM public.job_documents d
  LEFT JOIN qv v ON v.job_id = d.job_id AND v.document_id = d.id
  CROSS JOIN LATERAL (VALUES ('generated', d.created_at), ('sent', d.sent_at), ('viewed', d.viewed_at),
       ('accepted', d.accepted_at), ('declined', d.declined_at), ('superseded', d.superseded_at)) q(ev, at)
  WHERE d.job_id = ANY (p_job_ids) AND d.type ILIKE '%quote%' AND q.at IS NOT NULL AND q.at <= p_as_of
    AND NOT (q.ev = 'generated' AND d.sent_at IS NOT NULL AND d.sent_at <= p_as_of
             AND d.sent_at - d.created_at < interval '1 hour'
             AND (d.sent_at AT TIME ZONE 'Australia/Perth')::date = (d.created_at AT TIME ZONE 'Australia/Perth')::date)
  -- customer invoices (ACCREC) and supplier bills (ACCPAY, money we owe)
  UNION ALL
  SELECT i.job_id, coalesce((i.invoice_date::timestamp AT TIME ZONE 'Australia/Perth'), i.created_at),
         CASE WHEN i.invoice_date IS NULL THEN 'observed' ELSE 'date_only' END,
         CASE WHEN i.itype = 'ACCPAY' THEN 'supplier_bill' ELSE 'invoice' END,
         CASE WHEN i.itype = 'ACCPAY' THEN
                'Supplier bill ' || coalesce(i.invoice_number, i.reference, 'without a number') || ' from '
                || coalesce(i.contact_name, 'an unnamed supplier') || ': total ' || to_char(i.total, 'FM$999,999,990.00')
                || CASE WHEN i.st IN ('DELETED', 'VOIDED') THEN ', ' || lower(i.st) || ' in Xero (never counted)'
                        WHEN i.st = 'DRAFT' THEN ', draft in Xero'
                        WHEN i.st = 'PAID' THEN ', paid (money we owed)'
                        ELSE ', ' || lower(i.st) || ', we owe ' || to_char(coalesce(i.amount_due, 0), 'FM$999,999,990.00') END
              ELSE
                CASE WHEN i.st = 'DRAFT' THEN 'Draft invoice ' ELSE 'Invoice ' END
                || coalesce(i.invoice_number, 'without a number') || coalesce(' (' || nullif(i.reference, '') || ')', '')
                || ' to ' || coalesce(i.contact_name, 'an unnamed contact') || ': total ' || to_char(i.total, 'FM$999,999,990.00')
                || CASE WHEN i.st IN ('DELETED', 'VOIDED') THEN ', ' || lower(i.st) || ' in Xero (never counted)'
                        WHEN i.st = 'DRAFT' THEN ', not issued (a draft cannot be paid)'
                        WHEN i.st = 'PAID' THEN ', paid'
                        ELSE ', ' || lower(i.st) || coalesce(', due ' || to_char(i.due_date, 'Dy FMDD Mon YYYY'), '')
                             || ', owing ' || to_char(coalesce(i.amount_due, 0), 'FM$999,999,990.00') END
              END,
         i.total, i.contact_name, 'on_job', 'xero_invoices', i.id::text
  FROM inv i
  -- payments, credit notes, overpayments and prepayments applied (Xero raw record)
  UNION ALL
  SELECT p.job_id, p.at, 'date_only',
         CASE WHEN p.itype = 'ACCPAY' THEN 'supplier_payment' WHEN p.k = 'Payments' THEN 'payment' ELSE 'credit' END,
         CASE WHEN p.itype = 'ACCPAY' THEN
                CASE WHEN p.k = 'Payments' THEN 'We paid ' ELSE 'Supplier credit ' END || to_char(p.amt, 'FM$999,999,990.00')
                || ' on supplier bill ' || coalesce(p.invoice_number, p.reference, 'without a number')
                || ' (' || coalesce(p.contact_name, 'unnamed supplier') || ')'
              ELSE
                CASE p.k WHEN 'Payments' THEN 'Payment ' || to_char(p.amt, 'FM$999,999,990.00') || ' received on '
                     WHEN 'CreditNotes' THEN 'Credit note ' || coalesce(p.num || ' ', '') || to_char(p.amt, 'FM$999,999,990.00') || ' applied to '
                     WHEN 'Overpayments' THEN 'Earlier overpayment ' || to_char(p.amt, 'FM$999,999,990.00') || ' applied to '
                     ELSE 'Prepayment ' || to_char(p.amt, 'FM$999,999,990.00') || ' applied to ' END
                || coalesce(p.invoice_number, 'an invoice without a number') || ' (' || coalesce(p.contact_name, 'unnamed contact') || ')'
         END,
         p.amt, p.contact_name, 'on_job', 'xero_invoices', p.id::text
  FROM (
   SELECT i.job_id, i.id, i.itype, i.invoice_number, i.reference, i.contact_name, k.k, e->>'CreditNoteNumber' AS num,
          coalesce(nullif(e->>'Amount', '')::numeric, nullif(e->>'AppliedAmount', '')::numeric) AS amt,
          CASE WHEN e->>'Date' ~ '^/Date\(-?[0-9]+' THEN to_timestamp(substring(e->>'Date' FROM '^/Date\((-?[0-9]+)')::numeric / 1000)
               WHEN e->>'Date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN ((e->>'Date')::date::timestamp AT TIME ZONE 'Australia/Perth')
               WHEN e->>'Date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+$' THEN ((e->>'Date')::timestamp AT TIME ZONE 'UTC')
          END AS at
   FROM inv i
   CROSS JOIN (VALUES ('Payments'), ('CreditNotes'), ('Overpayments'), ('Prepayments')) k(k)
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(i.raw_json->k.k) = 'array' THEN i.raw_json->k.k
                                                ELSE '[]'::jsonb END) e
   WHERE i.st NOT IN ('DELETED', 'VOIDED')) p
  WHERE p.amt IS NOT NULL AND p.at IS NOT NULL AND p.at <= p_as_of
  UNION ALL
  -- a paid invoice whose raw Xero copy carries no payment lines (the copy lags the
  -- columns): the paid-in-full date from the columns, labelled as such
  SELECT i.job_id, (i.fully_paid_on::timestamp AT TIME ZONE 'Australia/Perth'), 'date_only',
         CASE WHEN i.itype = 'ACCPAY' THEN 'supplier_payment' ELSE 'payment' END,
         CASE WHEN i.itype = 'ACCPAY' THEN 'Supplier bill ' ELSE 'Invoice ' END
           || coalesce(i.invoice_number, i.reference, 'without a number') || ' paid in full ('
           || to_char(coalesce(i.amount_paid, i.total), 'FM$999,999,990.00') || '; Xero shows the date, the payment detail is not synced)',
         coalesce(i.amount_paid, i.total), i.contact_name, 'on_job', 'xero_invoices', i.id::text
  FROM inv i
  WHERE i.st = 'PAID' AND i.fully_paid_on IS NOT NULL
    AND (i.fully_paid_on::timestamp AT TIME ZONE 'Australia/Perth') <= p_as_of
    AND jsonb_array_length(CASE WHEN jsonb_typeof(i.raw_json->'Payments') = 'array' THEN i.raw_json->'Payments' ELSE '[]'::jsonb END) = 0
  -- emails our system sent (quotes, invoices, notices)
  UNION ALL
  SELECT ee.job_id, coalesce(ee.sent_at, ee.created_at), 'observed', 'system_email',
         'Our system emailed ' || CASE WHEN jc.cmail IS NOT NULL AND position(jc.cmail IN lower(coalesce(ee.recipient, ''))) > 0
                                       THEN 'the customer' ELSE 'another address' END
           || ' (' || replace(coalesce(ee.email_type, 'email'), '_', ' ') || ', ' || coalesce(ee.status, 'status unknown') || ')'
           || coalesce(': ' || left(ee.subject, 160), ''),
         NULL, NULL, 'on_job', 'email_events', ee.id::text
  FROM public.email_events ee
  JOIN (SELECT jb.id, lower(nullif(btrim(jb.client_email), '')) AS cmail FROM public.jobs jb WHERE jb.id = ANY (p_job_ids)) jc
    ON jc.id = ee.job_id
  WHERE ee.job_id = ANY (p_job_ids) AND ee.created_at <= p_as_of
  -- bookings: the booked day with its status; observer mirrors kept apart
  UNION ALL
  SELECT a.job_id,
         CASE WHEN a.scheduled_date IS NULL THEN a.created_at
              WHEN a.start_time IS NOT NULL THEN ((a.scheduled_date + a.start_time) AT TIME ZONE 'Australia/Perth')
              ELSE (a.scheduled_date::timestamp AT TIME ZONE 'Australia/Perth') END,
         CASE WHEN a.scheduled_date IS NULL THEN 'observed' ELSE 'scheduled' END,
         CASE WHEN a.mirror THEN 'booking_mirror' ELSE 'booking' END,
         CASE WHEN a.mirror THEN 'Observer copy of a booking (not a crew booking): ' ELSE 'Booking: ' END
           || replace(coalesce(a.assignment_type, 'visit'), '_', ' ') || ' '
           || coalesce(to_char(a.scheduled_date, 'Dy FMDD Mon YYYY'), 'with no date set (shown when it was made)')
           || coalesce(' to ' || to_char(nullif(a.scheduled_end, a.scheduled_date), 'Dy FMDD Mon'), '')
           || coalesce(', ' || nullif(btrim(a.crew_name), ''), '') || ', ' || coalesce(a.status, 'status not set')
           || CASE WHEN a.confirmation_status IS NOT NULL THEN ' (crew planning: ' || a.confirmation_status || ')' ELSE '' END,
         NULL, NULL, 'on_job', 'job_assignments', a.id::text
  FROM asg a
  -- attendance: only started or complete counts
  UNION ALL
  SELECT a.job_id, coalesce(a.completed_at, a.started_at,
           -- a status-only completion: the end of the booked Perth day
           CASE WHEN lower(coalesce(a.status, '')) IN ('complete', 'completed') AND a.scheduled_date IS NOT NULL
                THEN ((a.scheduled_date + 1)::timestamp AT TIME ZONE 'Australia/Perth') - interval '1 second' END,
           (a.scheduled_date::timestamp AT TIME ZONE 'Australia/Perth'), a.created_at),
         CASE WHEN a.completed_at IS NOT NULL OR a.started_at IS NOT NULL THEN 'observed' ELSE 'date_only' END, 'attendance',
         CASE WHEN a.completed_at IS NOT NULL THEN 'Crew marked complete'
              WHEN lower(coalesce(a.status, '')) IN ('complete', 'completed') THEN 'Booking status complete (who and when not recorded)'
              WHEN a.started_at IS NOT NULL THEN 'Crew started'
              ELSE 'Booking status in progress (who and when not recorded)' END
           || ': ' || replace(coalesce(a.assignment_type, 'visit'), '_', ' ')
           || coalesce(' booked ' || to_char(a.scheduled_date, 'Dy FMDD Mon YYYY'), ' (no booked date)')
           || coalesce(', ' || nullif(btrim(a.crew_name), ''), ''),
         NULL, NULL, 'on_job', 'job_assignments', a.id::text
  FROM asg a
  WHERE NOT a.mirror AND (lower(coalesce(a.status, '')) IN ('complete', 'completed', 'in_progress') OR a.completed_at IS NOT NULL OR a.started_at IS NOT NULL)
    AND coalesce(a.completed_at, a.started_at,
          CASE WHEN lower(coalesce(a.status, '')) IN ('complete', 'completed') AND a.scheduled_date IS NOT NULL
               THEN ((a.scheduled_date + 1)::timestamp AT TIME ZONE 'Australia/Perth') - interval '1 second' END,
          (a.scheduled_date::timestamp AT TIME ZONE 'Australia/Perth'), a.created_at) <= p_as_of
  -- booking changes from the app timeline
  UNION ALL
  SELECT je.job_id, je.created_at, 'observed',
         CASE WHEN je.event_type = 'assignment_status_changed'
                   AND je.detail_json->>'new_status' IN ('started', 'in_progress', 'complete', 'completed') THEN 'attendance'
              WHEN je.detail_json->>'source' = 'ghost_auto_mirror' THEN 'booking_mirror'
              ELSE 'booking_change' END,
         CASE je.event_type
           WHEN 'assignment_created' THEN 'Booking made for '
                || coalesce(to_char(public.context_job_record_date(je.detail_json->>'date'), 'Dy FMDD Mon YYYY'), 'a date not recorded')
                || CASE WHEN je.detail_json->>'source' = 'ghost_auto_mirror' THEN ' (observer copy)' ELSE '' END
                || coalesce((SELECT CASE WHEN a.scheduled_date::text <> je.detail_json->>'date'
                                         THEN '; now booked ' || to_char(a.scheduled_date, 'Dy FMDD Mon YYYY') END
                             FROM public.job_assignments a
                             WHERE a.id = CASE WHEN je.detail_json->>'assignment_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                               THEN (je.detail_json->>'assignment_id')::uuid END), '')
           WHEN 'assignment_deleted' THEN 'Booking deleted' || coalesce(' (it was for '
                || to_char(public.context_job_record_date(coalesce(je.detail_json->>'date', je.detail_json->>'scheduled_date')), 'Dy FMDD Mon YYYY') || ')', '')
           WHEN 'assignment_removed' THEN 'Booking removed'
           WHEN 'assignment_rescheduled' THEN 'Booking moved'
                || coalesce(' from ' || to_char(public.context_job_record_date(coalesce(je.detail_json->>'old_date', je.detail_json->>'from')), 'Dy FMDD Mon'), '')
                || coalesce(' to ' || to_char(public.context_job_record_date(coalesce(je.detail_json->>'new_date', je.detail_json->>'to', je.detail_json->>'date')), 'Dy FMDD Mon'), '')
           WHEN 'assignment_confirmed' THEN 'Booking confirmed in crew planning'
                || coalesce(' for ' || to_char(public.context_job_record_date(je.detail_json->>'scheduled_date'), 'Dy FMDD Mon'), '')
                || CASE WHEN je.detail_json->>'notify_client' = 'true' THEN ' (client notified)' ELSE '' END
           WHEN 'assignment_status_changed' THEN 'Crew marked the booking ' || replace(coalesce(je.detail_json->>'new_status', '?'), '_', ' ')
           WHEN 'assignment_acknowledged' THEN 'Crew acknowledged the booking'
           ELSE replace(je.event_type, '_', ' ') END,
         NULL, NULL, 'on_job', 'job_events', je.id::text
  FROM public.job_events je
  WHERE je.job_id = ANY (p_job_ids) AND je.created_at <= p_as_of
    AND je.event_type IN ('assignment_created', 'assignment_deleted', 'assignment_removed', 'assignment_rescheduled',
                          'assignment_confirmed', 'assignment_status_changed', 'assignment_acknowledged')
  UNION ALL
  SELECT e.job_id, coalesce(e.event_at, e.occurred_at), 'observed',
         CASE WHEN e.event_type LIKE 'clock.%' THEN 'attendance' ELSE 'booking_change' END,
         CASE WHEN e.event_type = 'clock.clock_off' THEN 'Crew clocked off'
              WHEN e.event_type = 'clock.clock_on' THEN 'Crew clocked on'
              ELSE 'Booking ' || replace(replace(e.event_type, 'schedule.', ''), '_', ' ')
                   || coalesce(', ' || to_char(public.context_job_record_date(e.payload->>'old_date'), 'Dy FMDD Mon') || ' to '
                               || to_char(public.context_job_record_date(e.payload->>'new_date'), 'Dy FMDD Mon'), '') END,
         NULL, NULL, 'on_job', 'business_events', e.id::text
  FROM public.business_events e
  WHERE e.job_id = ANY (p_job_ids) AND coalesce(e.recorded_at, e.occurred_at) <= p_as_of
    AND (e.event_type LIKE 'schedule.%' OR e.event_type IN ('clock.clock_on', 'clock.clock_off'))
    AND NOT (e.event_type = 'schedule.assignment_deleted' AND EXISTS (
         SELECT 1 FROM public.job_events x WHERE x.job_id = e.job_id AND x.event_type = 'assignment_deleted'
           AND abs(extract(epoch FROM x.created_at - coalesce(e.event_at, e.occurred_at))) < 120))
  -- variations
  UNION ALL
  SELECT v.job_id, q.at, 'observed', 'variation',
         'Variation ' || coalesce(v.variation_number::text, '') || ' ' || q.ev || coalesce(': ' || left(v.description, 120), '')
           || coalesce(' (' || to_char(v.amount, 'FM$999,999,990.00') || ')', '') || ', now ' || coalesce(v.status, 'status not set'),
         CASE WHEN q.ev = 'raised' THEN v.amount END, NULL, 'on_job', 'job_variations', v.id::text
  FROM public.job_variations v
  CROSS JOIN LATERAL (VALUES ('raised', v.created_at), ('sent', v.sent_at), ('accepted', v.accepted_at),
       ('declined', v.declined_at)) q(ev, at)
  WHERE v.job_id = ANY (p_job_ids) AND q.at IS NOT NULL AND q.at <= p_as_of AND v.created_at <= p_as_of
  -- purchase orders and work orders
  UNION ALL
  SELECT p.job_id, p.created_at, 'observed', 'purchase_order',
         'Purchase order ' || coalesce(p.po_number, 'without a number') || coalesce(' to ' || p.supplier_name, '')
           || coalesce(' (' || to_char(p.total, 'FM$999,999,990.00') || ')', '') || ', ' || coalesce(p.status, 'status not set')
           || coalesce(', delivery ' || to_char(coalesce(p.confirmed_delivery_date, p.delivery_date), 'Dy FMDD Mon YYYY'), ''),
         p.total, p.supplier_name, 'on_job', 'purchase_orders', p.id::text
  FROM public.purchase_orders p WHERE p.job_id = ANY (p_job_ids) AND p.created_at <= p_as_of
  UNION ALL
  SELECT w.job_id, q.at, 'observed', 'work_order',
         'Work order ' || coalesce(w.wo_number, 'without a number') || ' ' || q.ev || coalesce(' (' || w.trade_name || ')', '')
           || ', now ' || coalesce(w.status, 'status not set'),
         NULL, w.trade_name, 'on_job', 'work_orders', w.id::text
  FROM public.work_orders w
  CROSS JOIN LATERAL (VALUES ('created', w.created_at), ('sent', w.sent_at), ('accepted', w.accepted_at),
       ('completed', w.completed_at)) q(ev, at)
  WHERE w.job_id = ANY (p_job_ids) AND q.at IS NOT NULL AND q.at <= p_as_of AND w.created_at <= p_as_of
  -- rectification: callback jobs opened against this job
  UNION ALL
  SELECT c.callback_parent_id, c.created_at, 'observed', 'rectification',
         'Callback job ' || coalesce(c.job_number, 'without a number') || ' opened (' || coalesce(c.status::text, '?') || ')',
         NULL, NULL, 'on_job', 'jobs', c.id::text
  FROM public.jobs c WHERE c.callback_parent_id = ANY (p_job_ids) AND c.created_at <= p_as_of
  -- make-safe milestones
  UNION ALL
  SELECT je.job_id, je.created_at, 'observed',
         CASE WHEN je.event_type = 'makesafe_reattend' THEN 'rectification' ELSE 'makesafe' END,
         CASE je.event_type
           WHEN 'makesafe_created' THEN 'Make-safe card created'
           WHEN 'makesafe_report_submitted' THEN 'Trade make-safe report submitted'
           WHEN 'makesafe_report_sent_at_derived' THEN 'Make-safe report sent to the builder'
           WHEN 'makesafe_pack_sent_at_derived' THEN 'Make-safe pack sent to the builder'
           WHEN 'makesafe_portal_report_done' THEN 'Builder portal report marked done'
           WHEN 'makesafe_reattend' THEN 'Make-safe re-attend opened'
           WHEN 'makesafe_cancelled' THEN 'Make-safe cancelled'
           ELSE 'Make-safe stage: ' || replace(coalesce(je.detail_json->>'substatus', je.detail_json->>'new_substatus',
                                                         je.detail_json->>'to', '?'), '_', ' ') END,
         NULL, NULL, 'on_job', 'job_events', je.id::text
  FROM public.job_events je
  WHERE je.job_id = ANY (p_job_ids) AND je.created_at <= p_as_of
    AND je.event_type IN ('makesafe_created', 'makesafe_report_submitted', 'makesafe_report_sent_at_derived',
                          'makesafe_pack_sent_at_derived', 'makesafe_portal_report_done', 'makesafe_reattend',
                          'makesafe_substatus_changed', 'makesafe_cancelled')
  -- CRM tasks
  UNION ALL
  SELECT e.job_id, coalesce(e.event_at, e.occurred_at), 'observed', 'task',
         'CRM task ' || replace(replace(e.event_type, 'ghl.task_', ''), '_', ' ') || coalesce(': ' || left(e.payload->>'title', 160), '')
           || coalesce(', due ' || (e.payload->>'due_date'), ''),
         NULL, NULL, 'on_job', 'business_events', e.id::text
  FROM public.business_events e
  WHERE e.job_id = ANY (p_job_ids) AND e.event_type LIKE 'ghl.task\_%' AND coalesce(e.recorded_at, e.occurred_at) <= p_as_of
  -- staff notes: their words, no rule
  UNION ALL
  SELECT c.job_id, c.at, 'observed', 'note', 'Staff note: ' || c.words, NULL, NULL, c.placement, c.source_table, c.source_id
  FROM msg c WHERE c.is_note AND btrim(coalesce(c.words, '')) <> ''
  UNION ALL
  SELECT je.job_id, je.created_at, 'observed', 'note',
         'Staff note: ' || left(regexp_replace(coalesce(je.detail_json->>'text', je.detail_json->>'note', ''), '\s+', ' ', 'g'), 300),
         NULL, NULL, 'on_job', 'job_events', je.id::text
  FROM public.job_events je
  WHERE je.job_id = ANY (p_job_ids) AND je.event_type IN ('note', 'note_added') AND je.created_at <= p_as_of
    AND btrim(coalesce(je.detail_json->>'text', je.detail_json->>'note', '')) <> ''
    AND NOT EXISTS (SELECT 1 FROM msg c WHERE c.job_id = je.job_id AND c.is_note
                    AND abs(extract(epoch FROM c.at - je.created_at)) < 300)
  -- documents read into evidence (file name only) and documents sent
  UNION ALL
  SELECT e.job_id, coalesce(e.event_at, e.occurred_at), 'observed', 'document',
         'Document read: ' || coalesce(nullif(e.payload->'document'->>'file_name', ''), nullif(e.payload->'document'->>'label', ''), 'unnamed file'),
         NULL, NULL, 'on_job', 'business_events', e.id::text
  FROM public.business_events e
  WHERE e.job_id = ANY (p_job_ids) AND e.event_type = 'document.text_extracted' AND coalesce(e.recorded_at, e.occurred_at) <= p_as_of
  UNION ALL
  SELECT d.job_id, d.sent_at, 'observed', 'document',
         initcap(replace(d.type, '_', ' ')) || ' sent' || coalesce(': ' || left(d.file_name, 120), ''),
         NULL, NULL, 'on_job', 'job_documents', d.id::text
  FROM public.job_documents d
  WHERE d.job_id = ANY (p_job_ids) AND d.type NOT ILIKE '%quote%' AND d.sent_at IS NOT NULL AND d.sent_at <= p_as_of
 )
 SELECT m.job_id, m.at, (m.at AT TIME ZONE 'Australia/Perth')::date AS perth_date, m.time_basis, m.kind,
        replace(replace(m.what, chr(8212), ', '), chr(8211), '-') AS what, m.amount, m.party, m.placement,
        m.source_table, m.source_id,
        -- the state of the record the row cites, so no reader infers it from the words:
        -- invoices draft | issued | paid | voided; documents generated | sent | viewed |
        -- accepted | declined | superseded (as of p_as_of); crew bookings scheduled |
        -- attended (started, completed, or a status-only completion) | cancelled (not
        -- standing); every other row null. Crew planning's confirmation is never read.
        CASE m.source_table
         WHEN 'xero_invoices' THEN (SELECT CASE WHEN i.st = 'DRAFT' THEN 'draft' WHEN i.st = 'PAID' THEN 'paid'
                                               WHEN i.st IN ('VOIDED', 'DELETED') THEN 'voided'
                                               WHEN i.st IN ('AUTHORISED', 'SUBMITTED') THEN 'issued' END
                                    FROM inv i WHERE i.id::text = m.source_id)
         WHEN 'job_documents' THEN (SELECT CASE WHEN d.accepted_at <= p_as_of THEN 'accepted' WHEN d.declined_at <= p_as_of THEN 'declined'
                                               WHEN d.superseded_at <= p_as_of THEN 'superseded' WHEN d.viewed_at <= p_as_of THEN 'viewed'
                                               WHEN d.sent_at <= p_as_of THEN 'sent' ELSE 'generated' END
                                    FROM public.job_documents d
                                    WHERE d.id = CASE WHEN m.source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                                      THEN m.source_id::uuid END)
         WHEN 'job_assignments' THEN (SELECT CASE WHEN a.mirror THEN NULL
                                                 WHEN a.completed_at <= p_as_of OR a.started_at <= p_as_of
                                                      OR (lower(coalesce(a.status, '')) IN ('complete', 'completed')
                                                          AND a.completed_at IS NULL AND a.started_at IS NULL
                                                          -- a status-only completion counts from the end of its booked day
                                                          AND (a.scheduled_date IS NULL OR ((a.scheduled_date + 1)::timestamp
                                                               AT TIME ZONE 'Australia/Perth') - interval '1 second' <= p_as_of)) THEN 'attended'
                                                 WHEN lower(coalesce(a.status, '')) IN ('cancelled', 'deleted', 'draft', 'disputed', 'declined')
                                                 THEN 'cancelled'
                                                 ELSE 'scheduled' END
                                      FROM asg a WHERE a.id::text = m.source_id)
        END AS state,
        CASE WHEN m.source_table = 'job_assignments' THEN (SELECT a.created_at FROM asg a WHERE a.id::text = m.source_id AND NOT a.mirror) END
         AS made_at
 FROM m WHERE m.at IS NOT NULL
 ORDER BY m.job_id, m.at, m.kind, m.source_id
$fn$;
COMMENT ON FUNCTION public.context_job_record_timeline(uuid[], timestamptz) IS
 'Job record (20261006011000): one row per record milestone per job, oldest first (job created, first contact, site visit, quote version events with value, folded status changes, invoices, payments, credits, supplier bills, system emails, bookings, booking changes, attendance, variations, purchase and work orders, rectification, make-safe, tasks, staff notes, documents). time_basis observed|date_only|stamp|scheduled. state: the cited record''s state (invoices draft, issued, paid, voided; documents generated, sent, viewed, accepted, declined, superseded; crew bookings scheduled, attended (started, completed, or status complete with neither recorded), cancelled (not standing: cancelled, deleted, draft, disputed, declined); else null); made_at: a crew booking''s created time. A status-only completion is timed at the end of its booked Perth day. Rows recorded after p_as_of are ignored; mutable rows are read as now. Service role only.';

-- 3. Loops: record-closable loops and checks.
CREATE OR REPLACE FUNCTION public.context_job_record_loops(p_job_ids uuid[], p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, rule text, loop_key text, shown_as text, owner text, counterparty text, what text, why text,
 opened_at timestamptz, due_date date, amount numeric, about_key text, closes_when text, source_table text, source_id text,
 placement text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH j AS (
  SELECT jb.id, jb.job_number, jb.status::text AS status, jb.type::text AS type,
         nullif(btrim(jb.ghl_contact_id), '') AS ccontact,
         CASE WHEN jb.accepted_at <= p_as_of THEN jb.accepted_at END AS accepted_at,
         CASE WHEN jsonb_typeof(jb.pricing_json->'totalIncGST') = 'number' THEN (jb.pricing_json->>'totalIncGST')::numeric END AS price_inc,
         jb.quoted_value, jb.created_at,
         (p_as_of AT TIME ZONE 'Australia/Perth')::date AS today
  FROM public.jobs jb WHERE jb.id = ANY (p_job_ids)
 ),
 jv AS (  -- job value exactly as the reference: price_inc, else quoted_value (zero counts as none)
  SELECT j.*,
         CASE WHEN coalesce(j.price_inc, 0) <> 0 THEN j.price_inc WHEN coalesce(j.quoted_value, 0) <> 0 THEN j.quoted_value END AS value,
         CASE WHEN coalesce(j.price_inc, 0) <> 0 THEN 'pricing_json.totalIncGST' WHEN coalesce(j.quoted_value, 0) <> 0 THEN 'jobs.quoted_value' END AS value_basis
  FROM j
 ),
 msg AS (SELECT * FROM public.context_job_record_messages(p_job_ids, p_as_of)),
 bm AS (SELECT * FROM msg WHERE msg.source_table = 'business_events' AND msg.is_msg),
 outs AS (SELECT * FROM bm WHERE bm.direction = 'outbound' AND bm.customer_side AND coalesce(bm.sent_by_kind, '') <> 'workflow'),
 ins AS (SELECT * FROM bm WHERE bm.direction = 'inbound' AND bm.customer_side AND bm.channel IN ('sms', 'email')),
 inv AS (
  SELECT x.id, x.job_id, x.invoice_number, x.reference, x.contact_name, x.xero_contact_id, x.xero_invoice_id,
         x.total, x.amount_due, x.amount_paid, x.invoice_date, x.due_date, x.created_at,
         upper(coalesce(x.status, 'NONE')) AS st, upper(coalesce(x.invoice_type, 'ACCREC')) AS itype,
         'invoice:' || lower(coalesce(nullif(btrim(x.invoice_number), ''), 'id-' || left(x.id::text, 8))) AS about
  FROM public.xero_invoices x
  WHERE x.job_id = ANY (p_job_ids) AND coalesce(x.created_at, x.synced_at, '-infinity'::timestamptz) <= p_as_of
 ),
 sales AS (SELECT * FROM inv WHERE inv.itype = 'ACCREC'),
 qd AS (  -- quote documents as the reference reads them (type contains "quote"), stamps after p_as_of unset
  SELECT d.id, d.job_id, d.quote_number, d.version, d.created_at,
         CASE WHEN d.sent_at <= p_as_of THEN d.sent_at END AS sent_at,
         CASE WHEN d.viewed_at <= p_as_of THEN d.viewed_at END AS viewed_at,
         CASE WHEN d.accepted_at <= p_as_of THEN d.accepted_at END AS accepted_at,
         CASE WHEN d.declined_at <= p_as_of THEN d.declined_at END AS declined_at,
         CASE WHEN d.superseded_at <= p_as_of THEN d.superseded_at END AS superseded_at
  FROM public.job_documents d
  WHERE d.job_id = ANY (p_job_ids) AND d.type ILIKE '%quote%' AND d.created_at <= p_as_of
 ),
 acc AS (SELECT jv.id AS job_id, (jv.accepted_at IS NOT NULL OR EXISTS (SELECT 1 FROM qd WHERE qd.job_id = jv.id AND qd.accepted_at IS NOT NULL)) AS accepted FROM jv),
 asg AS (
  SELECT a.id, a.job_id, a.scheduled_date, a.status, a.created_at, a.updated_at, a.started_at, a.completed_at,
         a.confirmation_status, a.crew_name, a.assignment_type,
         coalesce(a.is_ghost, false) OR coalesce(a.role, '') = 'observer' AS mirror
  FROM public.job_assignments a WHERE a.job_id = ANY (p_job_ids) AND a.created_at <= p_as_of
 ),
 vo AS (
  SELECT j.id AS job_id, o.id, o.visit_start, o.outcome, o.quote_owed, o.supersedes
  FROM j JOIN public.visit_outcomes o ON o.job_id = j.id OR (j.ccontact IS NOT NULL AND o.contact_id = j.ccontact)
  WHERE o.recorded_at <= p_as_of
 ),
 lp AS (
  -- R1 overdue (reference rule)
  SELECT i.job_id, 'R1_overdue'::text AS rule, i.id::text AS sid, 'xero_invoices'::text AS tbl, 'loop'::text AS shown_as,
         'customer'::text AS owner, 'us'::text AS counterparty,
         coalesce(i.invoice_number, 'An invoice without a number') || ' ' || to_char(i.amount_due, 'FM$999,999,990.00')
           || ' overdue from ' || coalesce(i.contact_name, 'an unnamed contact') || ' since '
           || to_char(i.due_date, 'Dy FMDD Mon YYYY') || ' (' || (jv.today - i.due_date) || ' days)' AS what,
         'Xero shows it ' || lower(i.st) || ' with ' || to_char(i.amount_due, 'FM$999,999,990.00') || ' due and the due date passed' AS why,
         (i.due_date::timestamp AT TIME ZONE 'Australia/Perth') AS opened_at, i.due_date AS due, i.amount_due AS amount, i.about,
         'Xero shows nothing owing (paid, credited, voided or deleted)' AS closes_when
  FROM sales i JOIN jv ON jv.id = i.job_id
  WHERE i.st IN ('AUTHORISED', 'SUBMITTED') AND coalesce(i.amount_due, 0) > 0 AND i.due_date IS NOT NULL AND i.due_date < jv.today
  UNION ALL
  -- R2 part paid (reference rule)
  SELECT i.job_id, 'R2_part_paid', i.id::text, 'xero_invoices', 'loop', 'customer', 'us',
         coalesce(i.invoice_number, 'An invoice without a number') || ' part paid: ' || to_char(i.amount_paid, 'FM$999,999,990.00')
           || ' of ' || to_char(i.total, 'FM$999,999,990.00') || ', ' || to_char(i.amount_due, 'FM$999,999,990.00') || ' still owing from '
           || coalesce(i.contact_name, 'an unnamed contact'),
         'Xero shows a payment and an amount still due', coalesce(i.invoice_date::timestamp AT TIME ZONE 'Australia/Perth', i.created_at),
         i.due_date, i.amount_due, i.about, 'Xero shows nothing owing'
  FROM sales i
  WHERE i.st IN ('AUTHORISED', 'SUBMITTED') AND coalesce(i.amount_due, 0) > 0 AND coalesce(i.amount_paid, 0) > 0
  UNION ALL
  -- M1 money due, not yet overdue
  SELECT i.job_id, 'M1_money_due', i.id::text, 'xero_invoices', 'loop', 'customer', 'us',
         coalesce(i.invoice_number, 'An invoice without a number') || ' ' || to_char(i.amount_due, 'FM$999,999,990.00')
           || ' owing from ' || coalesce(i.contact_name, 'an unnamed contact')
           || coalesce(', due ' || to_char(i.due_date, 'Dy FMDD Mon YYYY'), ', no due date in Xero'),
         'Xero shows it ' || lower(i.st) || ' with an amount due, not yet overdue',
         coalesce(i.invoice_date::timestamp AT TIME ZONE 'Australia/Perth', i.created_at), i.due_date, i.amount_due, i.about,
         'Xero shows nothing owing'
  FROM sales i JOIN jv ON jv.id = i.job_id
  WHERE i.st IN ('AUTHORISED', 'SUBMITTED') AND coalesce(i.amount_due, 0) > 0 AND (i.due_date IS NULL OR i.due_date >= jv.today)
  UNION ALL
  -- R3 draft not issued (reference rule)
  SELECT i.job_id, 'R3_draft', i.id::text, 'xero_invoices', 'loop', 'us', 'customer',
         'Draft invoice ' || coalesce(i.invoice_number, 'without a number') || ' ' || to_char(i.total, 'FM$999,999,990.00') || ' to '
           || coalesce(i.contact_name, 'an unnamed contact') || ' not issued since ' || to_char(i.invoice_date, 'Dy FMDD Mon YYYY')
           || coalesce(' (' || (SELECT string_agg(coalesce(o.invoice_number, 'unnumbered') || ' ' || lower(o.st), ', ')
                                FROM sales o WHERE o.job_id = i.job_id AND o.id <> i.id AND o.reference = i.reference)
                       || ' on the same reference)', ''),
         'A draft in Xero cannot be paid; it is more than a day old',
         (i.invoice_date::timestamp AT TIME ZONE 'Australia/Perth'), NULL::date, i.total, i.about,
         'Approved (issued), voided or deleted in Xero'
  FROM sales i
  WHERE i.st = 'DRAFT' AND i.invoice_date IS NOT NULL
    AND extract(epoch FROM p_as_of - (i.invoice_date::timestamp AT TIME ZONE 'Australia/Perth')) > 86400
  UNION ALL
  -- R4 missed call not returned (reference rule)
  SELECT c.job_id, 'R4_missed_call', c.source_id, 'business_events', 'loop', 'us', 'customer',
         'Missed call from the customer ' || to_char(c.at AT TIME ZONE 'Australia/Perth', 'Dy FMDD Mon HH24:MI')
           || '; no call, text or email to the customer since',
         'The call record shows it was not answered (' || coalesce(substring(c.words FROM 'Provider status: ([A-Za-z_-]+)'), 'missed') || ')',
         c.at, NULL::date, NULL::numeric, 'contact:missed-call', 'A call, text or email from us to the customer after it'
  FROM bm c
  WHERE c.direction = 'inbound' AND c.channel = 'call' AND c.is_job_contact IS TRUE AND c.bad_call
    AND NOT EXISTS (SELECT 1 FROM outs o WHERE o.job_id = c.job_id AND o.at > c.at)
  UNION ALL
  -- R5 customer wrote last (reference rule; a candidate until a reader says a reply is owed)
  SELECT l.job_id, 'R5_customer_wrote_last', l.source_id, 'business_events', 'candidate', 'us', 'customer',
         'Customer ' || CASE WHEN l.channel = 'email' THEN 'emailed' ELSE 'texted' END || ' '
           || to_char(l.at AT TIME ZONE 'Australia/Perth', 'Dy FMDD Mon HH24:MI') || ' and nothing went to the customer since: "'
           || left(l.words, 160) || '"',
         'The newest customer message is newer than our newest customer-facing message (automated texts not counted)',
         l.at, NULL::date, NULL::numeric, 'contact:customer-reply', 'A text, email or call from us to the customer after it'
  FROM (SELECT DISTINCT ON (i.job_id) i.* FROM ins i ORDER BY i.job_id, i.at DESC, i.source_id DESC) l
  WHERE NOT EXISTS (SELECT 1 FROM outs o WHERE o.job_id = l.job_id AND o.at > l.at)
    AND extract(epoch FROM p_as_of - l.at) > 86400
  UNION ALL
  -- R6 booking passed, status unmoved (reference rule)
  SELECT b.job_id, 'R6_booking_passed_status_unmoved', b.id::text, 'job_assignments', 'check', 'us', 'customer',
         'Newest booking ' || to_char(b.scheduled_date, 'Dy FMDD Mon YYYY') || ' has passed and the status is still ' || replace(jv.status, '_', ' '),
         'No visit outcome after the booking and the status did not move on',
         (b.scheduled_date::timestamp AT TIME ZONE 'Australia/Perth'), b.scheduled_date, NULL::numeric,
         'booking:' || b.scheduled_date::text, 'The status moves on or a visit outcome is recorded'
  FROM (SELECT DISTINCT ON (a.job_id) a.* FROM asg a
        WHERE a.scheduled_date IS NOT NULL AND lower(coalesce(a.status, 'none')) NOT IN ('cancelled', 'deleted')
          AND NOT a.mirror  -- an observer's mirror is not a crew visit
        ORDER BY a.job_id, a.scheduled_date DESC, a.created_at, a.id) b
  JOIN jv ON jv.id = b.job_id
  WHERE b.scheduled_date < jv.today AND jv.status IN ('scheduled', 'processing', 'accepted')
    AND NOT EXISTS (SELECT 1 FROM vo WHERE vo.job_id = b.job_id
                    AND (vo.visit_start AT TIME ZONE 'Australia/Perth')::date >= b.scheduled_date)
  UNION ALL
  -- R7 quote waiting (reference rule; a check once the job is accepted)
  SELECT q.job_id, 'R7_quote_waiting', q.id::text, 'job_documents',
         CASE WHEN acc.accepted THEN 'check' ELSE 'loop' END, 'customer', 'us',
         'Quote ' || coalesce(q.quote_number, 'without a number') || coalesce(' v' || q.version, '') || ' sent '
           || to_char(q.sent_at AT TIME ZONE 'Australia/Perth', 'Dy FMDD Mon YYYY') || ' ('
           || floor(extract(epoch FROM p_as_of - q.sent_at) / 86400) || ' days)'
           || CASE WHEN q.viewed_at IS NOT NULL THEN ', viewed' ELSE ', not viewed' END
           || '; no answer and no customer message since',
         'Newest sent quote not accepted, declined or superseded, sent more than 7 days ago',
         q.sent_at, NULL::date, NULL::numeric,
         'quote:' || lower(coalesce(nullif(btrim(q.quote_number), ''), 'doc-' || left(q.id::text, 8))),
         'Acceptance, decline, a newer version, or a customer message'
  FROM (SELECT DISTINCT ON (d.job_id) d.* FROM qd d WHERE d.sent_at IS NOT NULL
        ORDER BY d.job_id, d.sent_at DESC, d.created_at, d.id) q
  JOIN acc ON acc.job_id = q.job_id
  WHERE q.accepted_at IS NULL AND q.declined_at IS NULL AND q.superseded_at IS NULL
    AND p_as_of - q.sent_at >= interval '8 days'
    AND NOT EXISTS (SELECT 1 FROM ins i WHERE i.job_id = q.job_id AND i.at > q.sent_at)
  UNION ALL
  -- R8 not yet invoiced after acceptance (reference rule)
  SELECT jv.id, 'R8_not_yet_invoiced', jv.id::text, 'jobs', 'loop', 'us', 'customer',
         'Job value ' || to_char(jv.value, 'FM$999,999,990.00') || ' (' || jv.value_basis || '); issued invoices '
           || to_char(coalesce(s.issued, 0), 'FM$999,999,990.00') || '; ' || to_char(jv.value - coalesce(s.issued, 0), 'FM$999,999,990.00')
           || ' not yet invoiced',
         'The job is accepted and issued customer invoices total less than the job value',
         coalesce(jv.accepted_at, (SELECT min(qd.accepted_at) FROM qd WHERE qd.job_id = jv.id)), NULL::date,
         jv.value - coalesce(s.issued, 0), 'payment:final', 'Issued invoices reach the job value, or the job value is corrected'
  FROM jv JOIN acc ON acc.job_id = jv.id
  LEFT JOIN LATERAL (SELECT sum(coalesce(i.total, 0)) AS issued FROM sales i
                     WHERE i.job_id = jv.id AND i.st NOT IN ('DRAFT', 'DELETED', 'VOIDED')) s ON true
  WHERE acc.accepted AND jv.value IS NOT NULL AND jv.value - coalesce(s.issued, 0) > 1
  UNION ALL
  -- C1 status lags the work: the newest sign that work is done while the status is an earlier stage
  SELECT w.job_id, 'C1_status_lags_work', w.sid, w.tbl, 'check', 'us', 'nobody',
         'Status is still ' || replace(jv.status, '_', ' ') || ' but ' || w.what, 'Records show the work done while the status lags',
         w.at, NULL::date, NULL::numeric, 'other:status-lags-work', 'The status moves on'
  FROM (SELECT DISTINCT ON (x.job_id) x.* FROM (
         SELECT je.job_id, je.id::text AS sid, 'job_events'::text AS tbl, je.created_at AS at,
                CASE je.event_type WHEN 'makesafe_report_sent_at_derived' THEN 'the make-safe report was sent '
                                   WHEN 'makesafe_pack_sent_at_derived' THEN 'the make-safe pack was sent '
                                   ELSE 'the builder portal report was marked done ' END
                || to_char(je.created_at AT TIME ZONE 'Australia/Perth', 'Dy FMDD Mon YYYY') AS what
         FROM public.job_events je
         WHERE je.job_id = ANY (p_job_ids) AND je.created_at <= p_as_of
           AND je.event_type IN ('makesafe_report_sent_at_derived', 'makesafe_pack_sent_at_derived', 'makesafe_portal_report_done')
         UNION ALL
         SELECT a.job_id, a.id::text, 'job_assignments', coalesce(a.completed_at, (a.scheduled_date::timestamp AT TIME ZONE 'Australia/Perth')),
                CASE WHEN a.completed_at IS NOT NULL THEN 'the crew marked the ' || to_char(a.scheduled_date, 'Dy FMDD Mon YYYY') || ' booking complete'
                     ELSE 'the ' || to_char(a.scheduled_date, 'Dy FMDD Mon YYYY') || ' booking status says complete (who and when not recorded)' END
         FROM asg a WHERE NOT a.mirror AND (a.status = 'complete' OR a.completed_at IS NOT NULL)
         UNION ALL
         SELECT i.job_id, i.id::text, 'xero_invoices', coalesce(i.invoice_date::timestamp AT TIME ZONE 'Australia/Perth', i.created_at),
                'invoices reach the job value and are paid (' || coalesce(i.invoice_number, 'unnumbered') || ' paid)'
         FROM sales i JOIN jv ON jv.id = i.job_id
         WHERE i.st = 'PAID' AND jv.value IS NOT NULL
           AND (SELECT sum(coalesce(o.total, 0)) FROM sales o WHERE o.job_id = i.job_id AND o.st IN ('AUTHORISED', 'SUBMITTED', 'PAID')) >= jv.value - 1
           AND NOT EXISTS (SELECT 1 FROM sales o WHERE o.job_id = i.job_id AND o.st IN ('AUTHORISED', 'SUBMITTED') AND coalesce(o.amount_due, 0) > 0)
       ) x ORDER BY x.job_id, x.at DESC, x.sid) w
  JOIN jv ON jv.id = w.job_id
  WHERE jv.status IN ('quoted', 'accepted', 'partially_accepted', 'awaiting_deposit', 'deposit', 'approvals', 'order_materials',
                      'awaiting_supplier', 'schedule_install', 'scheduled', 'processing')
  UNION ALL
  -- C2 value mismatch: accepted quote value or issued invoices disagree with the job value by more than $1
  SELECT q.job_id, 'C2_value_mismatch', q.document_id::text, 'job_documents', 'check', 'us', 'nobody',
         'Accepted quote value ' || to_char(q.accepted_value, 'FM$999,999,990.00') || ' differs from the job value '
           || to_char(jv.value, 'FM$999,999,990.00') || ' (' || jv.value_basis || ')',
         'Money lines may use the wrong figure; a person should confirm which is current',
         q.accepted_at, NULL::date, q.accepted_value - jv.value, 'other:job-value', 'The values agree within $1'
  FROM (SELECT qd.job_id, (array_agg(qd.id ORDER BY qd.accepted_at DESC))[1] AS document_id, max(qd.accepted_at) AS accepted_at,
               sum(v.value_inc_gst) AS accepted_value, count(v.value_inc_gst) AS valued, count(*) AS n
        FROM qd JOIN j ON j.id = qd.job_id
        LEFT JOIN LATERAL (SELECT x.value_inc_gst FROM public.job_quote_values(qd.job_id) x WHERE x.document_id = qd.id LIMIT 1) v ON true
        WHERE qd.accepted_at IS NOT NULL GROUP BY qd.job_id) q
  JOIN jv ON jv.id = q.job_id
  WHERE q.valued = q.n AND jv.value IS NOT NULL AND abs(q.accepted_value - jv.value) > 1
  UNION ALL
  SELECT jv.id, 'C2_value_mismatch', jv.id::text, 'jobs', 'check', 'us', 'nobody',
         'Issued invoices ' || to_char(s.issued, 'FM$999,999,990.00') || ' exceed the job value ' || to_char(jv.value, 'FM$999,999,990.00')
           || ' (' || jv.value_basis || ')',
         'Money lines may use the wrong figure; a person should confirm which is current',
         p_as_of, NULL::date, s.issued - jv.value, 'other:job-value', 'The values agree within $1'
  FROM jv JOIN LATERAL (SELECT sum(coalesce(i.total, 0)) AS issued FROM sales i
                        WHERE i.job_id = jv.id AND i.st IN ('AUTHORISED', 'SUBMITTED', 'PAID')) s ON true
  WHERE jv.value IS NOT NULL AND s.issued > jv.value + 1
  UNION ALL
  -- C3 a paid event while Xero still shows the invoice owing (records win; the event closes nothing)
  SELECT p.job_id, 'C3_paid_event_not_in_xero', p.eid, 'business_events', 'check', 'us', 'customer',
         'A payment event was logged ' || to_char(p.at AT TIME ZONE 'Australia/Perth', 'Dy FMDD Mon YYYY') || ' for '
           || coalesce(i.invoice_number, 'an invoice') || ' but Xero still shows ' || to_char(i.amount_due, 'FM$999,999,990.00') || ' owing',
         'Xero is the record; the event does not close the money', p.at, i.due_date, i.amount_due, i.about,
         'Xero shows the invoice paid, or the event is explained'
  FROM (SELECT DISTINCT ON (e.job_id, coalesce(e.payload->>'xero_invoice_id', e.payload->>'invoice_number'))
               e.job_id, e.id::text AS eid, coalesce(e.event_at, e.occurred_at) AS at,
               e.payload->>'xero_invoice_id' AS xid, e.payload->>'invoice_number' AS num
        FROM public.business_events e
        WHERE e.job_id = ANY (p_job_ids) AND coalesce(e.recorded_at, e.occurred_at) <= p_as_of
          AND e.event_type IN ('invoice.paid', 'payment.received', 'payment.reconciled')
        ORDER BY e.job_id, coalesce(e.payload->>'xero_invoice_id', e.payload->>'invoice_number'), coalesce(e.event_at, e.occurred_at) DESC) p
  JOIN sales i ON i.job_id = p.job_id AND (i.xero_invoice_id = p.xid OR (p.xid IS NULL AND i.invoice_number = p.num))
  WHERE i.st IN ('AUTHORISED', 'SUBMITTED') AND coalesce(i.amount_due, 0) > 0
  UNION ALL
  -- C4 attendance not recorded: a booking today or passed with no start or completion, and no later booking complete
  SELECT b.job_id, 'C4_booking_attendance_unrecorded', b.id::text, 'job_assignments', 'check', 'us', 'crew',
         b.n || CASE WHEN b.n = 1 THEN ' booking' ELSE ' bookings' END || ' on or before today with no start or completion recorded; newest '
           || to_char(b.scheduled_date, 'Dy FMDD Mon YYYY') || coalesce(' (' || nullif(btrim(b.crew_name), '') || ')', ''),
         'The crew did not mark it started or complete, so the record cannot say whether anyone attended',
         (b.scheduled_date::timestamp AT TIME ZONE 'Australia/Perth'), b.scheduled_date, NULL::numeric,
         'booking:' || b.scheduled_date::text, 'The crew marks it started or complete, or it is cancelled'
  FROM (SELECT DISTINCT ON (a.job_id) a.*, count(*) OVER (PARTITION BY a.job_id) AS n
        FROM asg a JOIN jv ON jv.id = a.job_id
        WHERE NOT a.mirror AND a.scheduled_date <= jv.today AND coalesce(a.status, 'scheduled') NOT IN ('complete', 'cancelled', 'in_progress')
          AND a.started_at IS NULL AND a.completed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM asg c WHERE c.job_id = a.job_id AND NOT c.mirror AND c.scheduled_date >= a.scheduled_date
                          AND (c.status = 'complete' OR c.completed_at IS NOT NULL))
        ORDER BY a.job_id, a.scheduled_date DESC, a.id) b
  UNION ALL
  -- C5 future booking still tentative in crew planning (not a customer confirmation)
  SELECT b.job_id, 'C5_tentative_booking', b.id::text, 'job_assignments', 'check', 'us', 'crew',
         'Booking ' || to_char(b.scheduled_date, 'Dy FMDD Mon YYYY') || ' is still ' || b.confirmation_status || ' in crew planning',
         'Crew planning status only; nothing records whether the customer confirmed the date',
         b.created_at, b.scheduled_date, NULL::numeric, 'booking:' || b.scheduled_date::text,
         'Crew planning marks it confirmed, or it is cancelled or passes'
  FROM (SELECT DISTINCT ON (a.job_id) a.* FROM asg a JOIN jv ON jv.id = a.job_id
        WHERE NOT a.mirror AND a.scheduled_date >= jv.today AND coalesce(a.status, '') NOT IN ('cancelled', 'complete')
          AND a.confirmation_status IN ('tentative', 'placeholder')
        ORDER BY a.job_id, a.scheduled_date, a.id) b
  UNION ALL
  -- C6 the customer wrote after a future booking was made and it has not changed since
  SELECT b.job_id, 'C6_booking_after_customer_word', c.source_id, c.source_table, 'check', 'us', 'customer',
         'Booked ' || b.dates || '; the customer wrote ' || to_char(c.at AT TIME ZONE 'Australia/Perth', 'Dy FMDD Mon HH24:MI')
           || CASE WHEN c.placement = 'not_placed' THEN ' (an email not placed on any job)' ELSE '' END
           || ' after it was made and the booking has not changed since: "' || left(c.words, 160) || '"',
         'A person or the reader must judge whether the message objects to the date',
         c.at, b.first_date, NULL::numeric, 'booking:' || b.first_date::text,
         'The booking is changed or confirmed after that message, or our reply confirms the date'
  FROM (SELECT a.job_id, string_agg(DISTINCT to_char(a.scheduled_date, 'Dy FMDD Mon'), ', ') AS dates,
               max(coalesce(a.updated_at, a.created_at)) AS changed, min(a.scheduled_date) AS first_date
        FROM asg a JOIN jv ON jv.id = a.job_id
        WHERE NOT a.mirror AND a.scheduled_date >= jv.today AND coalesce(a.status, '') NOT IN ('cancelled', 'complete')
        GROUP BY a.job_id) b
  JOIN LATERAL (SELECT m.* FROM msg m
                WHERE m.job_id = b.job_id AND m.customer_side AND m.direction = 'inbound' AND m.channel IN ('sms', 'email')
                  AND m.at > b.changed AND (m.at AT TIME ZONE 'Australia/Perth')::date <= b.first_date
                ORDER BY m.at DESC, m.source_id DESC LIMIT 1) c ON true
  UNION ALL
  -- C7 CRM task still open
  SELECT t.job_id, 'C7_task_open', t.id::text, 'business_events', 'check', 'us', 'nobody',
         'CRM task still open: ' || coalesce(left(t.payload->>'title', 160), 'no title') || coalesce(', due ' || (t.payload->>'due_date'), ''),
         'Task created and no completed or deleted row since', coalesce(t.event_at, t.occurred_at), NULL::date, NULL::numeric,
         'other:task-' || left(t.id::text, 8), 'The task is completed or deleted in the CRM'
  FROM public.business_events t
  WHERE t.job_id = ANY (p_job_ids) AND t.event_type = 'ghl.task_created' AND coalesce(t.recorded_at, t.occurred_at) <= p_as_of
    AND NOT EXISTS (SELECT 1 FROM public.business_events x WHERE x.job_id = t.job_id
                    AND x.event_type IN ('ghl.task_completed', 'ghl.task_deleted')
                    AND x.payload->>'ghl_task_id' = t.payload->>'ghl_task_id' AND coalesce(x.recorded_at, x.occurred_at) <= p_as_of)
  UNION ALL
  -- C8 variation open
  SELECT v.job_id, 'C8_variation_open', v.id::text, 'job_variations', 'check',
         CASE WHEN v.status = 'sent' THEN 'customer' ELSE 'us' END, CASE WHEN v.status = 'sent' THEN 'us' ELSE 'customer' END,
         'Variation ' || coalesce(v.variation_number::text, '') || coalesce(' ' || to_char(v.amount, 'FM$999,999,990.00'), '')
           || ' is ' || coalesce(v.status, 'without a status') || coalesce(': ' || left(v.description, 120), ''),
         'Not accepted, declined or invoiced', coalesce(v.sent_at, v.created_at), NULL::date, v.amount,
         'variation:' || coalesce(v.variation_number::text, left(v.id::text, 8)), 'The variation is accepted, declined or invoiced'
  FROM public.job_variations v
  WHERE v.job_id = ANY (p_job_ids) AND v.created_at <= p_as_of
    AND coalesce(v.status, '') NOT IN ('accepted', 'declined', 'rejected', 'invoiced')
  UNION ALL
  -- C9 a visit outcome says a quote is owed and none was sent after the visit
  SELECT o.job_id, 'C9_visit_quote_owed', o.id::text, 'visit_outcomes', 'check', 'us', 'customer',
         'Visit ' || to_char(o.visit_start AT TIME ZONE 'Australia/Perth', 'Dy FMDD Mon YYYY') || ' recorded that a quote is owed; none sent since',
         'Visit outcome quote_owed', o.visit_start, NULL::date, NULL::numeric, 'quote:after-visit', 'A quote is sent after the visit'
  FROM vo o
  WHERE o.quote_owed AND o.outcome = 'happened'
    AND NOT EXISTS (SELECT 1 FROM public.visit_outcomes s WHERE s.supersedes = o.id)
    AND NOT EXISTS (SELECT 1 FROM qd WHERE qd.job_id = o.job_id AND qd.sent_at > o.visit_start)
  UNION ALL
  -- C10 the stage needs a visit and none is booked
  SELECT jv.id, 'C10_no_next_booking', jv.id::text, 'jobs', 'check', 'us', 'customer',
         'Status ' || replace(jv.status, '_', ' ') || ' and no visit is booked from today'
           || coalesce(' (last booking ' || to_char((SELECT max(a.scheduled_date) FROM asg a WHERE a.job_id = jv.id AND NOT a.mirror
                                                     AND coalesce(a.status, '') <> 'cancelled'), 'Dy FMDD Mon YYYY') || ')', ''),
         'The stage needs a visit and no booking is dated today or later', p_as_of, NULL::date, NULL::numeric,
         'booking:next', 'A booking dated today or later is made, or the status moves on'
  FROM jv
  WHERE jv.status IN ('scheduled', 'in_progress', 'rectification', 'schedule_install')
    AND NOT EXISTS (SELECT 1 FROM asg a WHERE a.job_id = jv.id AND NOT a.mirror AND a.scheduled_date >= jv.today
                    AND coalesce(a.status, '') <> 'cancelled')
  UNION ALL
  -- C11 the customer's newest legacy-inbox email has no customer-facing reply after it (a candidate like R5)
  SELECT l.job_id, 'C11_customer_mail_unanswered', l.source_id, 'inbox_events', 'candidate', 'us', 'customer',
         'Customer emailed ' || to_char(l.at AT TIME ZONE 'Australia/Perth', 'Dy FMDD Mon HH24:MI')
           || ' (stored only in the old inbox' || CASE WHEN l.placement = 'not_placed' THEN ', not placed on any job' ELSE '' END
           || ') and nothing went to the customer since: "' || left(l.words, 160) || '"',
         'The email has no copy in the evidence rows, so the R5 rule cannot see it',
         l.at, NULL::date, NULL::numeric, 'contact:customer-reply', 'A text, email or call from us to the customer after it'
  FROM (SELECT DISTINCT ON (m.job_id) m.* FROM msg m
        WHERE m.source_table = 'inbox_events' AND m.customer_side ORDER BY m.job_id, m.at DESC, m.source_id DESC) l
  WHERE NOT EXISTS (SELECT 1 FROM outs o WHERE o.job_id = l.job_id AND o.at > l.at)
    AND extract(epoch FROM p_as_of - l.at) > 86400
 )
 SELECT lp.job_id, lp.rule, lp.rule || ':' || lp.sid AS loop_key, lp.shown_as, lp.owner, lp.counterparty,
        replace(replace(lp.what, chr(8212), ', '), chr(8211), '-') AS what, lp.why, lp.opened_at, lp.due AS due_date,
        round(lp.amount, 2) AS amount, lp.about AS about_key, lp.closes_when, lp.tbl AS source_table, lp.sid AS source_id,
        -- where the cited message sits: on_job, or not_placed (mail from the client's
        -- address the old inbox placed on no job); null for a record row
        CASE WHEN lp.tbl = 'inbox_events'
             THEN coalesce((SELECT m.placement FROM msg m WHERE m.job_id = lp.job_id AND m.source_table = 'inbox_events'
                            AND m.source_id = lp.sid LIMIT 1), 'on_job')
             WHEN lp.tbl = 'business_events' THEN 'on_job' END AS placement
 FROM lp
 ORDER BY lp.job_id, lp.rule, lp.opened_at, lp.sid
$fn$;
COMMENT ON FUNCTION public.context_job_record_loops(uuid[], timestamptz) IS
 'Job record (20261006011000): record-closable loops per job. R1_overdue, R2_part_paid, R3_draft, R4_missed_call, R5_customer_wrote_last, R6_booking_passed_status_unmoved, R7_quote_waiting, R8_not_yet_invoiced are exactly the proof-set reference rules (tests.md T2, grade_ref.py record_loops); M1_money_due; checks C1 to C11 (a person''s look, never an obligation). shown_as loop|candidate|check. loop_key = rule:source_id. about_key per the ledger vocabulary. placement says where a cited message sits (on_job, or not_placed: client mail the old inbox placed on no job, labelled in the words); null for a record row. Service role only.';

-- 4. Money per paying party.
CREATE OR REPLACE FUNCTION public.context_job_record_money(p_job_ids uuid[], p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, party text, xero_contact_id text, invoiced numeric, paid numeric, credited numeric, owing numeric,
 overdue numeric, oldest_overdue_due date, drafts integer, draft_total numeric, invoices jsonb, job_value numeric,
 job_value_basis text, not_yet_invoiced numeric, supplier_bills jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH j AS (
  SELECT jb.id, CASE WHEN jb.accepted_at <= p_as_of THEN jb.accepted_at END AS accepted_at,
         CASE WHEN jsonb_typeof(jb.pricing_json->'totalIncGST') = 'number' THEN (jb.pricing_json->>'totalIncGST')::numeric END AS price_inc,
         jb.quoted_value, (p_as_of AT TIME ZONE 'Australia/Perth')::date AS today
  FROM public.jobs jb WHERE jb.id = ANY (p_job_ids)
 ),
 jv AS (
  SELECT j.*,
         CASE WHEN coalesce(j.price_inc, 0) <> 0 THEN j.price_inc WHEN coalesce(j.quoted_value, 0) <> 0 THEN j.quoted_value END AS value,
         CASE WHEN coalesce(j.price_inc, 0) <> 0 THEN 'pricing_json.totalIncGST' WHEN coalesce(j.quoted_value, 0) <> 0 THEN 'jobs.quoted_value' END AS basis,
         (j.accepted_at IS NOT NULL OR EXISTS (SELECT 1 FROM public.job_documents d WHERE d.job_id = j.id AND d.type ILIKE '%quote%'
                                                AND d.accepted_at <= p_as_of AND d.created_at <= p_as_of)) AS accepted
  FROM j
 ),
 inv AS (
  SELECT x.id, x.job_id, x.invoice_number, x.reference, x.contact_name, x.xero_contact_id, x.total, x.amount_due, x.amount_paid,
         x.invoice_date, x.due_date, x.fully_paid_on, x.raw_json, upper(coalesce(x.status, 'NONE')) AS st,
         upper(coalesce(x.invoice_type, 'ACCREC')) AS itype
  FROM public.xero_invoices x
  WHERE x.job_id = ANY (p_job_ids) AND coalesce(x.created_at, x.synced_at, '-infinity'::timestamptz) <= p_as_of
    AND upper(coalesce(x.status, '')) NOT IN ('DELETED', 'VOIDED')
 ),
 sale AS (
  SELECT i.*, jv.today,
         coalesce(nullif(btrim(i.xero_contact_id), ''), 'name:' || lower(btrim(i.contact_name)), 'unknown') AS pkey,
         -- paid: Xero's own AmountPaid column (the sum of the raw Payments when the raw
         -- record is current); credited: the raw AmountCredited when the raw record is
         -- current, else what the columns leave (total - paid - due). The raw record can lag
         -- the columns (status PAID with an older AUTHORISED raw copy): then xero_detail_stale.
         coalesce(i.amount_paid, (SELECT sum(nullif(p->>'Amount', '')::numeric)
                                  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.raw_json->'Payments') = 'array'
                                                                 THEN i.raw_json->'Payments' ELSE '[]'::jsonb END) p), 0) AS paid_amt,
         CASE WHEN jsonb_typeof(i.raw_json->'AmountCredited') = 'number' AND upper(coalesce(i.raw_json->>'Status', '')) = i.st
              THEN (i.raw_json->>'AmountCredited')::numeric
              WHEN i.st IN ('AUTHORISED', 'SUBMITTED', 'PAID')
              THEN greatest(coalesce(i.total, 0) - coalesce(i.amount_paid, 0) - coalesce(i.amount_due, 0), 0)
              ELSE 0 END AS credited_amt,
         (upper(coalesce(i.raw_json->>'Status', i.st)) <> i.st) AS raw_stale,
         jsonb_build_object(
          'id', i.id, 'number', i.invoice_number, 'reference', i.reference, 'status', i.st, 'total', i.total,
          'paid', NULL, 'owing', CASE WHEN i.st IN ('AUTHORISED', 'SUBMITTED') THEN coalesce(i.amount_due, 0) ELSE 0 END,
          'invoice_date', i.invoice_date, 'due_date', i.due_date, 'fully_paid_on', i.fully_paid_on,
          'xero_detail_stale', upper(coalesce(i.raw_json->>'Status', i.st)) <> i.st,
          'overdue', i.st IN ('AUTHORISED', 'SUBMITTED') AND coalesce(i.amount_due, 0) > 0 AND i.due_date < jv.today,
          'days_overdue', CASE WHEN i.st IN ('AUTHORISED', 'SUBMITTED') AND coalesce(i.amount_due, 0) > 0 AND i.due_date < jv.today
                               THEN jv.today - i.due_date END,
          'payments', (SELECT coalesce(jsonb_agg(jsonb_build_object('date',
                              CASE WHEN p->>'Date' ~ '^/Date\(-?[0-9]+' THEN (to_timestamp(substring(p->>'Date' FROM '^/Date\((-?[0-9]+)')::numeric / 1000)
                                                                              AT TIME ZONE 'Australia/Perth')::date END,
                              'amount', nullif(p->>'Amount', '')::numeric)), '[]'::jsonb)
                       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.raw_json->'Payments') = 'array' THEN i.raw_json->'Payments' ELSE '[]'::jsonb END) p),
          'credits', (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', c.k, 'number', c.e->>'CreditNoteNumber', 'date',
                              CASE WHEN c.e->>'Date' ~ '^/Date\(-?[0-9]+' THEN (to_timestamp(substring(c.e->>'Date' FROM '^/Date\((-?[0-9]+)')::numeric / 1000)
                                                                                AT TIME ZONE 'Australia/Perth')::date END,
                              'amount', nullif(c.e->>'AppliedAmount', '')::numeric)), '[]'::jsonb)
                      FROM (SELECT 'credit_note'::text AS k, e FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.raw_json->'CreditNotes') = 'array' THEN i.raw_json->'CreditNotes' ELSE '[]'::jsonb END) e
                            UNION ALL SELECT 'overpayment', e FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.raw_json->'Overpayments') = 'array' THEN i.raw_json->'Overpayments' ELSE '[]'::jsonb END) e
                            UNION ALL SELECT 'prepayment', e FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.raw_json->'Prepayments') = 'array' THEN i.raw_json->'Prepayments' ELSE '[]'::jsonb END) e) c)
         ) AS doc
  FROM inv i JOIN jv ON jv.id = i.job_id
  WHERE i.itype = 'ACCREC'
 ),
 issued AS (SELECT s.job_id, sum(coalesce(s.total, 0)) FILTER (WHERE s.st NOT IN ('DRAFT')) AS issued FROM sale s GROUP BY s.job_id),
 bills AS (
  SELECT i.job_id, jsonb_agg(jsonb_build_object('id', i.id, 'number', i.invoice_number, 'reference', i.reference,
           'supplier', i.contact_name, 'status', i.st, 'total', i.total, 'paid', coalesce(i.amount_paid, 0),
           'owing', CASE WHEN i.st IN ('AUTHORISED', 'SUBMITTED') THEN coalesce(i.amount_due, 0) ELSE 0 END,
           'invoice_date', i.invoice_date, 'due_date', i.due_date) ORDER BY i.invoice_date NULLS LAST, i.invoice_number) AS bills
  FROM inv i WHERE i.itype = 'ACCPAY' GROUP BY i.job_id
 ),
 party AS (
  SELECT s.job_id, s.pkey, (array_agg(s.contact_name ORDER BY s.invoice_date DESC NULLS LAST, s.id))[1] AS party,
         (array_agg(nullif(btrim(s.xero_contact_id), '') ORDER BY s.invoice_date DESC NULLS LAST, s.id))[1] AS xcid,
         sum(coalesce(s.total, 0)) FILTER (WHERE s.st IN ('AUTHORISED', 'SUBMITTED', 'PAID')) AS invoiced,
         sum(s.paid_amt) FILTER (WHERE s.st IN ('AUTHORISED', 'SUBMITTED', 'PAID')) AS paid,
         sum(s.credited_amt) FILTER (WHERE s.st IN ('AUTHORISED', 'SUBMITTED', 'PAID')) AS credited,
         sum(coalesce(s.amount_due, 0)) FILTER (WHERE s.st IN ('AUTHORISED', 'SUBMITTED')) AS owing,
         sum(coalesce(s.amount_due, 0)) FILTER (WHERE s.st IN ('AUTHORISED', 'SUBMITTED') AND s.due_date < s.today) AS overdue,
         min(s.due_date) FILTER (WHERE s.st IN ('AUTHORISED', 'SUBMITTED') AND coalesce(s.amount_due, 0) > 0 AND s.due_date < s.today) AS oldest,
         count(*) FILTER (WHERE s.st = 'DRAFT') AS drafts,
         sum(coalesce(s.total, 0)) FILTER (WHERE s.st = 'DRAFT') AS draft_total,
         jsonb_agg(s.doc || jsonb_build_object('paid', s.paid_amt, 'credited', s.credited_amt)
                   ORDER BY s.invoice_date NULLS LAST, s.invoice_number) AS invoices
  FROM sale s GROUP BY s.job_id, s.pkey
 ),
 rows_ AS (
  SELECT p.job_id, p.party, p.xcid, coalesce(p.invoiced, 0) AS invoiced, coalesce(p.paid, 0) AS paid,
         coalesce(p.credited, 0) AS credited, coalesce(p.owing, 0) AS owing, coalesce(p.overdue, 0) AS overdue, p.oldest,
         p.drafts::integer AS drafts, coalesce(p.draft_total, 0) AS draft_total, p.invoices
  FROM party p
  UNION ALL
  SELECT jv.id, NULL, NULL, 0, 0, 0, 0, 0, NULL, 0, 0, '[]'::jsonb
  FROM jv WHERE NOT EXISTS (SELECT 1 FROM party p WHERE p.job_id = jv.id)
 )
 SELECT r.job_id, r.party, r.xcid AS xero_contact_id, round(r.invoiced, 2) AS invoiced, round(r.paid, 2) AS paid,
        round(r.credited, 2) AS credited, round(r.owing, 2) AS owing, round(r.overdue, 2) AS overdue,
        r.oldest AS oldest_overdue_due, r.drafts, round(r.draft_total, 2) AS draft_total, r.invoices,
        jv.value AS job_value, jv.basis AS job_value_basis,
        CASE WHEN jv.accepted AND jv.value IS NOT NULL THEN round(greatest(jv.value - coalesce(iss.issued, 0), 0), 2) END AS not_yet_invoiced,
        coalesce(b.bills, '[]'::jsonb) AS supplier_bills
 FROM rows_ r JOIN jv ON jv.id = r.job_id
 LEFT JOIN issued iss ON iss.job_id = r.job_id
 LEFT JOIN bills b ON b.job_id = r.job_id
 ORDER BY r.job_id, r.owing DESC, r.party
$fn$;
COMMENT ON FUNCTION public.context_job_record_money(uuid[], timestamptz) IS
 'Job record (20261006011000): money per paying party (Xero ACCREC contact) per job: invoiced (issued), paid (Xero AmountPaid; payment dates from the raw Payments), credited (raw AmountCredited: credit notes, overpayments and prepayments applied; from the columns when the raw copy lags, flagged xero_detail_stale), owing, overdue, drafts, each invoice with payments and credits; plus one party-null row when there are no invoices. DELETED and VOIDED never count. ACCPAY bills are supplier_bills (money we owe). job_value is pricing_json.totalIncGST else jobs.quoted_value; not_yet_invoiced only after acceptance. Invoices are read as now. Service role only.';

-- 5. Contact: last exchanges and reply statistics.
CREATE OR REPLACE FUNCTION public.context_job_record_contact(p_job_ids uuid[], p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, last_customer_message jsonb, last_to_customer jsonb, last_internal jsonb, last_call_in jsonb,
 last_call_out jsonb, customer_messages integer, replies integer, median_reply_hours numeric, unanswered integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH msg AS (
  SELECT m.*, jsonb_build_object('at', m.at, 'channel', m.channel, 'direction', m.direction,
                                 -- a transcript holds both sides of a call, speakers unlabelled
                                 'text', CASE WHEN m.event_type = 'call.transcript_completed'
                                              THEN 'Call (speakers not labelled): ' || coalesce(m.words, '') ELSE m.words END,
                                 'table', m.source_table, 'id', m.source_id, 'automated', m.automated,
                                 'event_type', m.event_type,
                                 -- legacy mail from the client's address that no job holds is shown as such
                                 'placed_on', CASE WHEN m.placement = 'not_placed' THEN 'none' ELSE 'this_job' END)
              || CASE WHEN m.placement = 'not_placed' THEN jsonb_build_object('placement_note', 'not placed on any job')
                      ELSE '{}'::jsonb END AS doc,
         (m.channel = 'call' OR m.event_type IN ('client.call_logged', 'client.call_complete', 'call.transcript_completed')) AS is_call
  FROM public.context_job_record_messages(p_job_ids, p_as_of) m WHERE m.is_msg
 ),
 -- what the customer said: texts, emails (incl. legacy mail), answered calls and call transcripts
 lc AS (SELECT DISTINCT ON (m.job_id) m.job_id, m.doc FROM msg m
        WHERE m.customer_side AND m.direction = 'inbound' AND (m.channel IN ('sms', 'email') OR m.call_answered)
        ORDER BY m.job_id, m.at DESC, m.source_id DESC),
 -- what we told the customer: never automated
 lt AS (SELECT DISTINCT ON (m.job_id) m.job_id, m.at, m.doc FROM msg m
        WHERE m.customer_side AND m.direction = 'outbound' AND NOT m.automated
        ORDER BY m.job_id, m.at DESC, m.source_id DESC),
 la AS (SELECT DISTINCT ON (m.job_id) m.job_id, m.at, m.doc FROM msg m
        WHERE m.customer_side AND m.direction = 'outbound' AND m.automated
        ORDER BY m.job_id, m.at DESC, m.source_id DESC),
 li AS (SELECT DISTINCT ON (m.job_id) m.job_id, m.doc FROM msg m WHERE m.internal
        ORDER BY m.job_id, m.at DESC, m.source_id DESC),
 ci AS (SELECT DISTINCT ON (m.job_id) m.job_id, m.doc FROM msg m WHERE m.is_call AND m.direction = 'inbound' AND m.customer_side
        ORDER BY m.job_id, m.at DESC, m.source_id DESC),
 co AS (SELECT DISTINCT ON (m.job_id) m.job_id, m.doc FROM msg m WHERE m.is_call AND m.direction = 'outbound' AND m.customer_side
        ORDER BY m.job_id, m.at DESC, m.source_id DESC),
 -- one stream per job: customer texts and emails, and replies (anything we told the customer that
 -- was not automated, or an answered call either way); next_reply = the first reply strictly after
 stream AS (
  SELECT m.job_id, m.at, m.source_id, (m.customer_side AND m.direction = 'inbound' AND m.channel IN ('sms', 'email')) AS is_cust,
         ((m.customer_side AND m.direction = 'outbound' AND NOT m.automated)
          OR (m.customer_side AND m.call_answered AND NOT m.automated)) AS is_reply
  FROM msg m
 ),
 nr AS (
  SELECT s.job_id, s.at, s.source_id, s.is_cust,
         min(CASE WHEN s.is_reply THEN s.at END) OVER (PARTITION BY s.job_id ORDER BY s.at DESC, s.is_reply, s.source_id DESC
                                                      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS next_reply
  FROM stream s WHERE s.is_cust OR s.is_reply
 ),
 cm AS (  -- a run starts at a customer message with no earlier customer message, or one answered before it
  SELECT n.job_id, n.at, n.next_reply,
         (lag(n.at) OVER w IS NULL OR lag(n.next_reply) OVER w <= n.at) AS run_start
  FROM nr n WHERE n.is_cust
  WINDOW w AS (PARTITION BY n.job_id ORDER BY n.at, n.source_id)
 ),
 st AS (
  SELECT c.job_id, count(*)::integer AS customer_messages,
         (count(*) FILTER (WHERE c.run_start AND c.next_reply IS NOT NULL))::integer AS replies,
         round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM c.next_reply - c.at) / 3600)
                FILTER (WHERE c.run_start AND c.next_reply IS NOT NULL))::numeric, 1) AS median_reply_hours,
         (count(*) FILTER (WHERE c.next_reply IS NULL))::integer AS unanswered
  FROM cm c GROUP BY c.job_id
 )
 SELECT jb.id AS job_id, lc.doc AS last_customer_message,
        lt.doc || CASE WHEN la.at > lt.at THEN jsonb_build_object('newer_automated', la.doc) ELSE '{}'::jsonb END AS last_to_customer,
        li.doc AS last_internal, ci.doc AS last_call_in, co.doc AS last_call_out,
        coalesce(st.customer_messages, 0) AS customer_messages, coalesce(st.replies, 0) AS replies,
        st.median_reply_hours, coalesce(st.unanswered, 0) AS unanswered
 FROM public.jobs jb
 LEFT JOIN lc ON lc.job_id = jb.id LEFT JOIN lt ON lt.job_id = jb.id LEFT JOIN la ON la.job_id = jb.id
 LEFT JOIN li ON li.job_id = jb.id LEFT JOIN ci ON ci.job_id = jb.id LEFT JOIN co ON co.job_id = jb.id
 LEFT JOIN st ON st.job_id = jb.id
 WHERE jb.id = ANY (p_job_ids)
$fn$;
COMMENT ON FUNCTION public.context_job_record_contact(uuid[], timestamptz) IS
 'Job record (20261006011000): per job the last customer message, the last thing we told the customer (never automated; a newer automated send is attached as newer_automated), the last internal (crew or staff) message, the last calls each way, and reply statistics (customer texts and emails; a run of customer messages is answered by the first later message from us or answered call; automated texts never count). Each jsonb is {at, channel, direction, text (300 chars; a call transcript is prefixed "Call (speakers not labelled): "), table, id, automated, event_type, placed_on (this_job | none)}; legacy mail from the client''s address that no job holds has placed_on none and placement_note "not placed on any job". Service role only.';

-- 6. Access: service role only.
REVOKE ALL ON FUNCTION public.context_job_record_date(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_record_legacy_mail(uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_record_messages(uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_record_timeline(uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_record_loops(uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_record_money(uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_record_contact(uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_job_record_date(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_record_legacy_mail(uuid[], timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_record_messages(uuid[], timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_record_timeline(uuid[], timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_record_loops(uuid[], timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_record_money(uuid[], timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_record_contact(uuid[], timestamptz) TO service_role;
