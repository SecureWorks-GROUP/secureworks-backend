-- Story fixes after 972 (6 Oct 2026): one sort order, booked dates by date,
-- bounced quotes not waiting, app events on the timeline.
--
-- Why. Backend PR 972 put the job record layer (20261006011000) and the job story
-- (20261006014000) live. Four things it left are fixed here, each with a contract
-- case that fails on the 972 bodies:
--
--  1. One sort order. Production sorts text in its own language order (ICU en-US:
--     letters compared without case first, "_" and "-" before digits), CI and a
--     test cluster sort in another (spaces and punctuation ignored), and the
--     reader (TypeScript) compares in code order. So the same story could list people,
--     paying parties, loops, citations and notes in a different order on each, and
--     a tie decided which record loop an item attached to. Every text sort and
--     tiebreak whose order reaches the output is now in C (byte) order, with a full
--     tiebreak where rows could tie (an audit of every ORDER BY, DISTINCT and pick
--     in the story layer, 6 Oct 2026). A uuid tiebreak needs nothing: a uuid's
--     text sorts the same in every collation. The story's own read
--     (context_job_story) still passes its record parts in its old order: the
--     assembler now sorts everything it outputs, so that order no longer shows.
--  2. C6 named the booked days in the order of their weekday words ("Fri 16 Oct,
--     Mon 12 Oct"); now in date order, each day once.
--  3. R7 (quote waiting) read a quote whose every email bounced or failed, and
--     that the customer never viewed, as waiting on the customer's answer. It was
--     never received: it now says so and is our move (owner us), with the same
--     not-received rule as the timeline and the ledger store, as of the replay
--     instant. The rule still fires on the same quotes (the newest sent, at least
--     8 days ago, unanswered), so the record loops match the proof-set reference
--     rule.
--  4. The app events the ledger store lets close a matter
--     (context_ledger_job_event_closes: quote_sent, invoice.emailed,
--     acceptance_invoice_sent, payment_link_sent, payment_received,
--     payment_recorded, clock.clock_on, clock.clock_off,
--     makesafe_report_submitted, roof_report_submitted) are timeline lines citing
--     job_events, each with its event_type as its state, so a reader can cite them
--     and apply the store's list to them. One line per event type, matter and
--     Perth day (one live job has 401 identical payment-link rows), citing the
--     newest. An event naming a document whose every email bounced or failed,
--     never viewed or answered, has state not_delivered: the store lets it close
--     nothing. A crew clocking on or off is in job_events only (36 rows live, no
--     business_events copy), so it reaches the story for the first time.
--
-- Not changed: the ledger store's closing rules (context_ledger_*): the reader
-- mirrors them exactly and a mismatch counts against the shadow gate; the proposal
-- for declined items and closes_on record is docs/context/ledger-closes-proposal.md,
-- for after the shadow proof. Not replaced here: context_job_record_messages and
-- context_job_story_meta (PR 975), resolve_context_attribution (PR 966), the
-- email history functions (PR 974), the scorecards (PR 976). Every signature,
-- volatility, owner and grant stays; each comment keeps its slice name first.
--
-- Replaced bodies (guarded on the live md5 of each, read read-only from production):
--   context_job_record_timeline(uuid[], timestamptz)  4, and its sort
--   context_job_record_loops(uuid[], timestamptz)     2, 3, and its sorts
--   context_job_story_assemble(...)                   1
--   context_job_story_ledger(uuid, uuid, timestamptz) 1 (items tie by item_key)
--   context_client_story(uuid, timestamptz)           1
-- Query shape: the same reads in the same order; the timeline adds one indexed
-- read of the job's app events (job_events by job_id).
-- Rollback: supabase/rollbacks/20261006033000_context_story_fixups_down.sql
-- (the 972 bodies, word for word).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Guard. Each body replaced here must be the live 972 body (md5 of prosrc read
-- read-only from production on 6 Oct 2026) or this migration's own (a re-apply is
-- a no-op); anything else is someone else's change and is refused, never
-- overwritten. The helpers the new bodies read must exist.
DO $guard$
DECLARE problems text[] := '{}'; x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_job_record_timeline(uuid[],timestamptz)', ARRAY['a8b34905f83ab30739b8cbc5cf268748', '4c37cd16c59ff7c29d162615407b7819']),
  ('public.context_job_record_loops(uuid[],timestamptz)', ARRAY['b872b6d0f55411280de1bd0c405771fb', 'e2976900d488c53501f76f26a1a0403c']),
  ('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)', ARRAY['4860fd81fb02905e0ae0ddccd64d0f1c', 'aab2d2eb593890b297f6d13a486f6aa0']),
  ('public.context_job_story_ledger(uuid,uuid,timestamptz)', ARRAY['3352950310073c33cc83f64bd80f60a9', '7754e292f957c722d0fa56a3001f8ffd']),
  ('public.context_client_story(uuid,timestamptz)', ARRAY['3f2cc15aa814f9b993a80e282d1fd65b', 'cc4a2ce461deeb17653cd94b714bbf78'])
 ) v(sig, accepted) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS NULL OR NOT live = ANY (x.accepted) THEN
   problems := problems || format('%s md5 %s', x.sig, coalesce(live, '<missing>'));
  END IF;
 END LOOP;
 IF to_regprocedure('public.context_job_record_messages(uuid[],timestamptz)') IS NULL
    OR to_regprocedure('public.context_job_record_date(text)') IS NULL
    OR to_regprocedure('public.job_quote_values(uuid)') IS NULL
    OR to_regprocedure('public.context_job_record_money(uuid[],timestamptz)') IS NULL
    OR to_regprocedure('public.context_job_story_facts(uuid,timestamptz)') IS NULL
    OR to_regprocedure('public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)') IS NULL
    OR to_regprocedure('public.context_ledger_evidence_rows(uuid[],timestamptz)') IS NULL
    OR to_regprocedure('public.context_linked_status(text)') IS NULL THEN
  problems := problems || 'the record layer (20261006011000) or the story (20261006014000) is not complete'::text;
 END IF;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_story_fixups_preimage_mismatch: %; read the live definitions before replacing them',
   array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The timeline: app events on it, one sort order.
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
 -- app events the ledger store lets close a matter (context_ledger_job_event_closes):
 -- a reader cites them by id, and each line's state is its event_type
 ae0 AS (
  SELECT je.id, je.job_id, je.event_type, je.created_at, coalesce(je.detail_json, '{}'::jsonb) AS d,
         nullif(btrim(je.detail_json ->> 'document_id'), '') AS doc,
         CASE WHEN je.detail_json ->> 'assignment_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN (je.detail_json ->> 'assignment_id')::uuid END AS asg_id,
         CASE WHEN je.detail_json ->> 'fully_paid_on' ~ '^/Date\(-?[0-9]{1,13}[^0-9]'
              THEN (to_timestamp(substring(je.detail_json ->> 'fully_paid_on' FROM '^/Date\((-?[0-9]{1,13})')::numeric / 1000)
                    AT TIME ZONE 'Australia/Perth')::date
              ELSE public.context_job_record_date(je.detail_json ->> 'fully_paid_on') END AS paid_day,
         (je.created_at AT TIME ZONE 'Australia/Perth')::date AS day,
         -- the matter it records: its document, invoice, booking or report
         lower(coalesce(nullif(btrim(je.detail_json ->> 'document_id'), ''), nullif(btrim(je.detail_json ->> 'xero_invoice_id'), ''),
                        nullif(btrim(je.detail_json ->> 'invoice_number'), ''), nullif(btrim(je.detail_json ->> 'assignment_id'), ''),
                        nullif(btrim(je.detail_json ->> 'report_id'), ''), nullif(btrim(je.detail_json ->> 'report_doc_id'), ''),
                        nullif(btrim(je.detail_json ->> 'draft_id'), ''), '')) AS obj
  FROM public.job_events je
  WHERE je.job_id = ANY (p_job_ids) AND je.created_at <= p_as_of
    AND je.event_type IN ('quote_sent', 'invoice.emailed', 'acceptance_invoice_sent', 'payment_link_sent', 'payment_received',
                          'payment_recorded', 'clock.clock_on', 'clock.clock_off', 'makesafe_report_submitted', 'roof_report_submitted')
 ),
 -- one line per event type, matter and Perth day (an app that logs the same send
 -- over and over in a day is one line saying how many times), citing the newest.
 -- An event naming a document our system emailed whose every email bounced or
 -- failed, and that the customer never viewed or answered (as of p_as_of), was not
 -- received: the store lets it close nothing (context_ledger_cite, the same rule).
 ae AS (
  SELECT g.*,
         (g.doc IS NOT NULL
          AND EXISTS (SELECT 1 FROM public.email_events ee WHERE ee.metadata ->> 'document_id' = g.doc AND ee.created_at <= p_as_of)
          AND NOT EXISTS (SELECT 1 FROM public.email_events ee WHERE ee.metadata ->> 'document_id' = g.doc
                          AND lower(coalesce(ee.status, '')) IN ('sent', 'delivered', 'accepted') AND ee.sent_at IS NOT NULL AND ee.sent_at <= p_as_of)
          AND NOT EXISTS (SELECT 1 FROM public.job_documents d
                          WHERE d.id = CASE WHEN g.doc ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN g.doc::uuid END
                            AND (d.viewed_at <= p_as_of OR d.accepted_at <= p_as_of OR d.declined_at <= p_as_of))) AS not_received
  FROM (SELECT DISTINCT ON (x.job_id, x.event_type, x.obj, x.day) x.*,
               count(*) OVER (PARTITION BY x.job_id, x.event_type, x.obj, x.day) AS n,
               min(x.created_at) OVER (PARTITION BY x.job_id, x.event_type, x.obj, x.day) AS first_at
        FROM ae0 x
        ORDER BY x.job_id, x.event_type, x.obj, x.day, x.created_at DESC, x.id DESC) g
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
           || CASE WHEN q.ev = 'sent' AND de.undelivered THEN ', but every email of it bounced or failed: not received' ELSE '' END
           || CASE WHEN q.ev = 'sent' THEN coalesce(', value ' || to_char(v.value_inc_gst, 'FM$999,999,990.00') || ' inc GST',
                                                    ', value not recorded (' || coalesce(v.value_source, 'not a sent quote') || ')')
                   WHEN q.ev = 'accepted' THEN coalesce(', value ' || to_char(v.value_inc_gst, 'FM$999,999,990.00') || ' inc GST', '')
                   ELSE '' END,
         CASE WHEN q.ev IN ('sent', 'accepted') THEN v.value_inc_gst END, NULL, 'on_job', 'job_documents', d.id::text
  FROM public.job_documents d
  LEFT JOIN qv v ON v.job_id = d.job_id AND v.document_id = d.id
  -- a document our system emailed, every email of it bounced or failed (as of the
  -- replay instant), and the customer never viewed, accepted or declined it
  CROSS JOIN LATERAL (SELECT (EXISTS (SELECT 1 FROM public.email_events ee WHERE ee.metadata ->> 'document_id' = d.id::text AND ee.created_at <= p_as_of)
       AND NOT EXISTS (SELECT 1 FROM public.email_events ee WHERE ee.metadata ->> 'document_id' = d.id::text
        AND lower(coalesce(ee.status, '')) IN ('sent', 'delivered', 'accepted') AND ee.sent_at IS NOT NULL AND ee.sent_at <= p_as_of)
       AND NOT coalesce(d.viewed_at <= p_as_of OR d.accepted_at <= p_as_of OR d.declined_at <= p_as_of, false)) AS undelivered) de
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
           || coalesce(', ' || nullif(btrim(a.crew_name), ''), '') || ', ' || coalesce(a.status, 'status not set'),
         NULL, NULL, 'on_job', 'job_assignments', a.id::text
  FROM asg a
  -- attendance: only started or complete counts
  UNION ALL
  SELECT a.job_id, coalesce(a.completed_at, a.started_at,
           -- a status-only completion: the end of the booked Perth day, or now while
           -- that is still ahead (the status already says it happened)
           CASE WHEN lower(coalesce(a.status, '')) IN ('complete', 'completed') AND a.scheduled_date IS NOT NULL
                THEN least(((a.scheduled_date + 1)::timestamp AT TIME ZONE 'Australia/Perth') - interval '1 second', now()) END,
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
               THEN least(((a.scheduled_date + 1)::timestamp AT TIME ZONE 'Australia/Perth') - interval '1 second', now()) END,
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
    -- a "move" to the same date is no booking change
    AND NOT coalesce(je.event_type = 'assignment_rescheduled'
             AND public.context_job_record_date(coalesce(je.detail_json->>'old_date', je.detail_json->>'from'))
                 = public.context_job_record_date(coalesce(je.detail_json->>'new_date', je.detail_json->>'to', je.detail_json->>'date')), false)
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
    -- crew-planning marks are not booking changes: a lock, a status mark (old or
    -- new status: confirmed, tentative, placeholder) and a reschedule to the same
    -- date. A reschedule to another date is a real move and stays, whatever status
    -- keys the crew-planning writer adds to it (it always writes old and new status).
    AND e.event_type <> 'schedule.locked'
    AND NOT (e.event_type LIKE 'schedule.%' AND (e.payload ? 'old_status' OR e.payload ? 'new_status')
             AND NOT coalesce(e.event_type = 'schedule.rescheduled'
                  AND public.context_job_record_date(e.payload->>'old_date') <> public.context_job_record_date(e.payload->>'new_date'), false))
    AND NOT coalesce(e.event_type = 'schedule.rescheduled'
             AND public.context_job_record_date(e.payload->>'old_date') = public.context_job_record_date(e.payload->>'new_date'), false)
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
    -- (a trade's make-safe report is an app event the store lets close a visit: below, from ae)
    AND je.event_type IN ('makesafe_created', 'makesafe_report_sent_at_derived',
                          'makesafe_pack_sent_at_derived', 'makesafe_portal_report_done', 'makesafe_reattend',
                          'makesafe_substatus_changed', 'makesafe_cancelled')
  -- app events the ledger store lets close a matter: one line per event type,
  -- matter and Perth day, citing the newest (ae); its state is its event_type
  UNION ALL
  SELECT e.job_id, e.created_at, 'observed',
         CASE WHEN e.event_type = 'quote_sent' THEN 'quote'
              WHEN e.event_type IN ('invoice.emailed', 'acceptance_invoice_sent', 'payment_link_sent') THEN 'invoice'
              WHEN e.event_type IN ('payment_received', 'payment_recorded') THEN 'payment'
              WHEN e.event_type IN ('clock.clock_on', 'clock.clock_off') THEN 'attendance'
              ELSE 'makesafe' END,
         CASE e.event_type
          WHEN 'quote_sent' THEN 'App recorded ' || CASE WHEN qd.id IS NULL THEN 'a quote'
                                     ELSE 'quote ' || coalesce(qd.quote_number, 'without a number') || coalesce(' v' || qd.version, '') END
               || ' sent ' || CASE WHEN nullif(btrim(e.d ->> 'sent_to'), '') IS NULL THEN 'with no address recorded'
                                   WHEN jc.cmail IS NOT NULL AND position(jc.cmail IN lower(e.d ->> 'sent_to')) > 0 THEN 'to the customer'
                                   ELSE 'to another address' END
               || CASE WHEN e.not_received THEN ', but every email of it bounced or failed: not received' ELSE '' END
          WHEN 'invoice.emailed' THEN 'App recorded invoice ' || coalesce(nullif(btrim(e.d ->> 'invoice_number'), ''), 'without a number')
               || ' emailed ' || CASE WHEN nullif(btrim(e.d ->> 'to'), '') IS NULL THEN 'with no address recorded'
                                      WHEN jc.cmail IS NOT NULL AND position(jc.cmail IN lower(e.d ->> 'to')) > 0 THEN 'to the customer'
                                      ELSE 'to another address' END
               || coalesce(' via ' || nullif(btrim(e.d ->> 'via'), ''), '')
          WHEN 'acceptance_invoice_sent' THEN 'App recorded deposit invoice '
               || coalesce(nullif(btrim(e.d ->> 'invoice_number'), ''), 'without a number') || ' sent on acceptance'
               || CASE WHEN jsonb_typeof(e.d -> 'deposit_amount') = 'number'
                       THEN ' (deposit ' || to_char((e.d ->> 'deposit_amount')::numeric, 'FM$999,999,990.00') || ')' ELSE '' END
               || '; email ' || CASE WHEN e.d ->> 'branded_email_sent' = 'true' THEN 'sent' ELSE 'not recorded as sent' END
               || ', text ' || CASE WHEN e.d ->> 'sms_sent' = 'true' THEN 'sent' ELSE 'not recorded as sent' END
          WHEN 'payment_link_sent' THEN 'App recorded a payment link for invoice '
               || coalesce(nullif(btrim(e.d ->> 'invoice_number'), ''), 'without a number') || ' sent'
               || CASE WHEN e.d ->> 'sms_sent' = 'true' THEN ' by text' ELSE ' (the text was not recorded as sent)' END
          WHEN 'payment_received' THEN 'App recorded invoice ' || coalesce(nullif(btrim(e.d ->> 'invoice_number'), ''), 'without a number')
               || ' paid in full'
               || coalesce(' (' || nullif(concat_ws(', ', CASE WHEN jsonb_typeof(e.d -> 'amount_paid') = 'number'
                                                              THEN to_char((e.d ->> 'amount_paid')::numeric, 'FM$999,999,990.00') END,
                                                    'paid ' || to_char(e.paid_day, 'Dy FMDD Mon YYYY')), '') || ')', '')
          WHEN 'payment_recorded' THEN 'App recorded a payment' || coalesce(' on invoice ' || nullif(btrim(e.d ->> 'invoice_number'), ''), '')
          WHEN 'clock.clock_on' THEN 'Crew clocked on' || coalesce(' for the ' || to_char(ca.scheduled_date, 'Dy FMDD Mon YYYY') || ' booking', '')
          WHEN 'clock.clock_off' THEN 'Crew clocked off' || coalesce(' for the ' || to_char(ca.scheduled_date, 'Dy FMDD Mon YYYY') || ' booking', '')
               || CASE WHEN jsonb_typeof(e.d -> 'net_hours') = 'number'
                       THEN ' (' || rtrim(to_char((e.d ->> 'net_hours')::numeric, 'FM999990.99'), '.') || ' hours net)' ELSE '' END
          WHEN 'makesafe_report_submitted' THEN 'Trade make-safe report submitted'
          ELSE 'Trade roof report submitted' END
         || CASE WHEN e.n > 1 THEN '; recorded ' || e.n || ' times that day, first at '
                                   || to_char(e.first_at AT TIME ZONE 'Australia/Perth', 'HH24:MI') ELSE '' END,
         NULL, NULL, 'on_job', 'job_events', e.id::text
  FROM ae e
  LEFT JOIN public.job_documents qd ON qd.id = CASE WHEN e.doc ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN e.doc::uuid END
  LEFT JOIN public.job_assignments ca ON ca.id = e.asg_id
  LEFT JOIN (SELECT jb.id, lower(nullif(btrim(jb.client_email), '')) AS cmail FROM public.jobs jb WHERE jb.id = ANY (p_job_ids)) jc
    ON jc.id = e.job_id
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
        -- invoices draft | issued | paid | voided; documents generated | sent |
        -- not_delivered (every email of it bounced or failed, never viewed or answered) |
        -- viewed | accepted | declined | superseded (as of p_as_of); system emails sent |
        -- delivered | accepted (with a sent time) | not_sent | bounced | failed | queued;
        -- crew bookings scheduled | attended (started, completed, or a status-only
        -- completion) | cancelled (not standing); app events the ledger store lets close
        -- a matter: their event_type (quote_sent, invoice.emailed, payment_received,
        -- clock.clock_off ...), or not_delivered when the event names a document whose
        -- every email bounced or failed (never viewed or answered); every other row
        -- null. Crew planning's confirmation is never read.
        CASE m.source_table
         WHEN 'xero_invoices' THEN (SELECT CASE WHEN i.st = 'DRAFT' THEN 'draft' WHEN i.st = 'PAID' THEN 'paid'
                                               WHEN i.st IN ('VOIDED', 'DELETED') THEN 'voided'
                                               WHEN i.st IN ('AUTHORISED', 'SUBMITTED') THEN 'issued' END
                                    FROM inv i WHERE i.id::text = m.source_id)
         WHEN 'job_documents' THEN (SELECT CASE WHEN d.accepted_at <= p_as_of THEN 'accepted' WHEN d.declined_at <= p_as_of THEN 'declined'
                                               WHEN d.superseded_at <= p_as_of THEN 'superseded' WHEN d.viewed_at <= p_as_of THEN 'viewed'
                                               WHEN d.sent_at <= p_as_of AND (EXISTS (SELECT 1 FROM public.email_events ee WHERE ee.metadata ->> 'document_id' = d.id::text AND ee.created_at <= p_as_of)
                                                       AND NOT EXISTS (SELECT 1 FROM public.email_events ee WHERE ee.metadata ->> 'document_id' = d.id::text
                                                        AND lower(coalesce(ee.status, '')) IN ('sent', 'delivered', 'accepted') AND ee.sent_at IS NOT NULL AND ee.sent_at <= p_as_of)
                                                       AND NOT coalesce(d.viewed_at <= p_as_of OR d.accepted_at <= p_as_of OR d.declined_at <= p_as_of, false)) THEN 'not_delivered'
                                               WHEN d.sent_at <= p_as_of THEN 'sent' ELSE 'generated' END
                                    FROM public.job_documents d
                                    WHERE d.id = CASE WHEN m.source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                                      THEN m.source_id::uuid END)
         -- a system email: its status once it went out with a sent time, else not_sent
         -- (bounced, failed and queued say so)
         WHEN 'email_events' THEN (SELECT CASE WHEN lower(coalesce(ee.status, '')) IN ('sent', 'delivered', 'accepted')
                                                THEN CASE WHEN ee.sent_at IS NOT NULL THEN lower(ee.status) ELSE 'not_sent' END
                                               ELSE coalesce(nullif(lower(btrim(ee.status)), ''), 'unknown') END
                                    FROM public.email_events ee
                                    WHERE ee.id = CASE WHEN m.source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                                       THEN m.source_id::uuid END)
         WHEN 'job_assignments' THEN (SELECT CASE WHEN a.mirror THEN NULL
                                                 WHEN a.completed_at <= p_as_of OR a.started_at <= p_as_of
                                                      OR (lower(coalesce(a.status, '')) IN ('complete', 'completed')
                                                          AND a.completed_at IS NULL AND a.started_at IS NULL
                                                          -- a status-only completion counts from the end of its booked
                                                          -- day, or from now while that is still ahead
                                                          AND (a.scheduled_date IS NULL OR least(((a.scheduled_date + 1)::timestamp
                                                               AT TIME ZONE 'Australia/Perth') - interval '1 second', now()) <= p_as_of)) THEN 'attended'
                                                 WHEN lower(coalesce(a.status, '')) IN ('cancelled', 'deleted', 'draft', 'disputed', 'declined')
                                                 THEN 'cancelled'
                                                 ELSE 'scheduled' END
                                      FROM asg a WHERE a.id::text = m.source_id)
         WHEN 'job_events' THEN (SELECT CASE WHEN e.not_received THEN 'not_delivered' ELSE e.event_type END
                                  FROM ae e WHERE e.id::text = m.source_id)
        END AS state,
        CASE WHEN m.source_table = 'job_assignments' THEN (SELECT a.created_at FROM asg a WHERE a.id::text = m.source_id AND NOT a.mirror) END
         AS made_at
 FROM m WHERE m.at IS NOT NULL
 ORDER BY m.job_id, m.at, m.kind COLLATE "C", m.source_id COLLATE "C", m.what COLLATE "C"
$fn$;
COMMENT ON FUNCTION public.context_job_record_timeline(uuid[], timestamptz) IS
 'Job record (20261006011000), story fixes (20261006033000): app events the ledger store lets close a matter (quote_sent, invoice.emailed, acceptance_invoice_sent, payment_link_sent, payment_received, payment_recorded, clock.clock_on, clock.clock_off, makesafe_report_submitted, roof_report_submitted) are lines citing job_events, one per event type, matter and Perth day (the newest cited, the count named), each with state = its event_type, or not_delivered when it names a document whose every email bounced or failed and the customer never viewed or answered it; rows sort by time, then kind, source and words in C (byte) order. Earlier: one row per record milestone per job, oldest first (job created, first contact, site visit, quote version events with value, folded status changes, invoices, payments, credits, supplier bills, system emails, bookings, booking changes (never a crew-planning mark: a lock, a status mark, or a move to the same date), attendance, variations, purchase and work orders, rectification, make-safe, tasks, staff notes, documents). time_basis observed|date_only|stamp|scheduled. state: the cited record''s state (invoices draft, issued, paid, voided; documents generated, sent, viewed, accepted, declined, superseded; crew bookings scheduled, attended (started, completed, or status complete with neither recorded), cancelled (not standing: cancelled, deleted, draft, disputed, declined); else null); made_at: a crew booking''s created time. A status-only completion is timed at the end of its booked Perth day, or now while that is still ahead. Rows recorded after p_as_of are ignored; mutable rows are read as now. Service role only.';

-- 2. The loops: C6 dates by date; R7 not received when every email bounced; one sort order.
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
         a.crew_name, a.assignment_type,
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
           || coalesce(' (' || (SELECT string_agg(coalesce(o.invoice_number, 'unnumbered') || ' ' || lower(o.st), ', '
                                                  ORDER BY o.invoice_number COLLATE "C", o.id)
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
  -- R7 quote waiting (reference rule; a check once the job is accepted). A quote whose
  -- every email our system sent bounced or failed, and that the customer never viewed,
  -- was not received (the timeline's own rule, as of p_as_of): it waits on us to get it
  -- to them, not on the customer's answer.
  SELECT q.job_id, 'R7_quote_waiting', q.id::text, 'job_documents',
         CASE WHEN acc.accepted THEN 'check' ELSE 'loop' END,
         CASE WHEN de.undelivered THEN 'us' ELSE 'customer' END, CASE WHEN de.undelivered THEN 'customer' ELSE 'us' END,
         'Quote ' || coalesce(q.quote_number, 'without a number') || coalesce(' v' || q.version, '') || ' sent '
           || to_char(q.sent_at AT TIME ZONE 'Australia/Perth', 'Dy FMDD Mon YYYY') || ' ('
           || floor(extract(epoch FROM p_as_of - q.sent_at) / 86400) || ' days)'
           || CASE WHEN de.undelivered THEN ', but every email of it bounced or failed: not received; no customer message since'
                   WHEN q.viewed_at IS NOT NULL THEN ', viewed; no answer and no customer message since'
                   ELSE ', not viewed; no answer and no customer message since' END,
         CASE WHEN de.undelivered THEN 'Every email of the newest sent quote bounced or failed and the customer never viewed it, so it was not received'
              ELSE 'Newest sent quote not accepted, declined or superseded, sent more than 7 days ago' END,
         q.sent_at, NULL::date, NULL::numeric,
         'quote:' || lower(coalesce(nullif(btrim(q.quote_number), ''), 'doc-' || left(q.id::text, 8))),
         CASE WHEN de.undelivered THEN 'An email of it goes out, the customer views or answers it, or a newer version'
              ELSE 'Acceptance, decline, a newer version, or a customer message' END
  FROM (SELECT DISTINCT ON (d.job_id) d.* FROM qd d WHERE d.sent_at IS NOT NULL
        ORDER BY d.job_id, d.sent_at DESC, d.created_at, d.id) q
  JOIN acc ON acc.job_id = q.job_id
  CROSS JOIN LATERAL (SELECT (EXISTS (SELECT 1 FROM public.email_events ee WHERE ee.metadata ->> 'document_id' = q.id::text AND ee.created_at <= p_as_of)
       AND NOT EXISTS (SELECT 1 FROM public.email_events ee WHERE ee.metadata ->> 'document_id' = q.id::text
        AND lower(coalesce(ee.status, '')) IN ('sent', 'delivered', 'accepted') AND ee.sent_at IS NOT NULL AND ee.sent_at <= p_as_of)
       AND q.viewed_at IS NULL) AS undelivered) de
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
  -- (C5, a booking still tentative in crew planning, is retired: crew planning's
  -- confirmation is its own default, never the customer's word, so nothing reads it)
  -- C6 the customer wrote after a future booking was made and it has not changed since
  SELECT b.job_id, 'C6_booking_after_customer_word', c.source_id, c.source_table, 'check', 'us', 'customer',
         'Booked ' || b.dates || '; the customer wrote ' || to_char(c.at AT TIME ZONE 'Australia/Perth', 'Dy FMDD Mon HH24:MI')
           || CASE WHEN c.placement = 'not_placed' THEN ' (an email not placed on any job)' ELSE '' END
           || ' after it was made and the booking has not changed since: "' || left(c.words, 160) || '"',
         'A person or the reader must judge whether the message objects to the date',
         c.at, b.first_date, NULL::numeric, 'booking:' || b.first_date::text,
         'The booking is changed or confirmed after that message, or our reply confirms the date'
  -- the booked days in date order, each once (never in the order of their weekday words)
  FROM (SELECT a.job_id, (SELECT string_agg(to_char(x.d, 'Dy FMDD Mon'), ', ' ORDER BY x.d)
                          FROM unnest(array_agg(DISTINCT a.scheduled_date)) AS x(d)) AS dates,
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
 ORDER BY lp.job_id, lp.rule COLLATE "C", lp.opened_at, lp.sid COLLATE "C"
$fn$;
COMMENT ON FUNCTION public.context_job_record_loops(uuid[], timestamptz) IS
 'Job record (20261006011000), story fixes (20261006033000): C6 names the booked days in date order, each once; R7 on a quote whose every email bounced or failed and the customer never viewed it reads not received and is ours (owner us), not the customer''s answer; text sorts and tiebreaks in C (byte) order. Earlier: record-closable loops per job. R1_overdue, R2_part_paid, R3_draft, R4_missed_call, R5_customer_wrote_last, R6_booking_passed_status_unmoved, R7_quote_waiting, R8_not_yet_invoiced are exactly the proof-set reference rules (tests.md T2, grade_ref.py record_loops); M1_money_due; checks C1 to C4 and C6 to C11 (a person''s look, never an obligation; C5, crew planning''s tentative booking, is retired and crew planning''s confirmation is never read). shown_as loop|candidate|check. loop_key = rule:source_id. about_key per the ledger vocabulary. placement says where a cited message sits (on_job, or not_placed: client mail the old inbox placed on no job, labelled in the words); null for a record row. Service role only.';

-- 3. The story assembler: one sort order for everything it outputs.
CREATE OR REPLACE FUNCTION public.context_job_story_assemble(p_job jsonb, p_record jsonb, p_ledger jsonb, p_meta jsonb,
 p_as_of timestamptz, p_since timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql STABLE
AS $fn$
 WITH inp AS MATERIALIZED (
  SELECT p_job AS job, coalesce(p_record, '{}'::jsonb) AS rec, coalesce(p_ledger, '{}'::jsonb) AS led,
         coalesce(p_meta, '{}'::jsonb) AS meta, p_as_of AS as_of, (p_as_of AT TIME ZONE 'Australia/Perth')::date AS today,
         p_since AS since
 ),
 tl AS MATERIALIZED (
  SELECT t.* FROM inp, jsonb_to_recordset(coalesce(inp.rec->'timeline', '[]'::jsonb))
   AS t(at timestamptz, perth_date date, time_basis text, kind text, what text, amount numeric, party text, placement text,
        source_table text, source_id text, state text, made_at timestamptz)
 ),
 rl AS MATERIALIZED (
  SELECT l.* FROM inp, jsonb_to_recordset(coalesce(inp.rec->'loops', '[]'::jsonb))
   AS l(rule text, loop_key text, shown_as text, owner text, counterparty text, what text, why text, opened_at timestamptz,
        due_date date, amount numeric, about_key text, closes_when text, source_table text, source_id text, placement text)
 ),
 mo AS MATERIALIZED (
  SELECT m.* FROM inp, jsonb_to_recordset(coalesce(inp.rec->'money', '[]'::jsonb))
   AS m(party text, xero_contact_id text, invoiced numeric, paid numeric, credited numeric, owing numeric, overdue numeric,
        oldest_overdue_due date, drafts integer, draft_total numeric, invoices jsonb, job_value numeric, job_value_basis text,
        not_yet_invoiced numeric, supplier_bills jsonb)
 ),
 bk AS MATERIALIZED (  -- crew bookings (observer mirrors are not passed in)
  SELECT b.* FROM inp, jsonb_to_recordset(coalesce(inp.rec->'facts'->'bookings', '[]'::jsonb))
   AS b(id text, scheduled_date date, status text, assignment_type text, crew_name text, created_at timestamptz,
        started_at timestamptz, completed_at timestamptz)
 ),
 qd AS MATERIALIZED (
  SELECT q.* FROM inp, jsonb_to_recordset(coalesce(inp.rec->'facts'->'quotes', '[]'::jsonb))
   AS q(id text, quote_number text, version integer, sent_at timestamptz, accepted_at timestamptz, declined_at timestamptz,
        superseded_at timestamptz)
 ),
 cc AS MATERIALIZED (  -- records that may close a ledger item (closing evidence only)
  SELECT c.* FROM inp, jsonb_to_recordset(coalesce(inp.rec->'facts'->'closing', '[]'::jsonb))
   AS c(closes_on text, about_key text, at timestamptz, t text, id text, what text)
 ),
 li AS MATERIALIZED (  -- ledger items of the generation shown, with the citation re-check result
                       -- (what with em and en dashes replaced, as the store now writes it)
  SELECT i.* FROM inp, jsonb_to_recordset((SELECT coalesce(jsonb_agg(x || jsonb_build_object('what',
            btrim(replace(regexp_replace(x->>'what', '\s*' || chr(8212) || '\s*', ', ', 'g'), chr(8211), '-')))), '[]'::jsonb)
          FROM jsonb_array_elements(coalesce(inp.led->'items', '[]'::jsonb)) x))
   AS i(item_key text, item_type text, status text, from_role text, from_name text, to_role text, to_name text, what text,
        about_key text, modality text, phase text, due_date date, opened_at timestamptz, opened_by jsonb, closed_at timestamptz,
        closed_by jsonb, closes_on text, supersedes_key text, blocks text, needs_reply boolean, written_by text,
        person_locked boolean, cites_ok boolean, cited jsonb)
 ),
 vis AS MATERIALIZED (SELECT li.* FROM li WHERE coalesce(li.cites_ok, true)),
 led AS (  -- the generation shown (a JSON null generation is none), what its reader has not read yet,
           -- and the customer rows it has read (a candidate is judged only when its row is one)
  SELECT x.*,
         CASE WHEN x.gen IS NOT NULL THEN (inp.led->>'unread_rows')::integer END AS unread,
         CASE WHEN x.gen IS NOT NULL THEN coalesce(inp.led->'unread_ids', '[]'::jsonb) END AS unread_ids,
         CASE WHEN x.gen IS NOT NULL THEN coalesce(inp.led->'read_ids', '[]'::jsonb) END AS read_ids
  FROM inp, LATERAL (
   SELECT coalesce(nullif(inp.led->>'status', ''), 'none') AS status, nullif(inp.led->'generation', 'null'::jsonb) AS gen,
          (inp.led->'generation'->>'evidence_until')::timestamptz AS evidence_until,
          (SELECT count(*) FROM vis) AS items, (SELECT count(*) FROM li WHERE NOT coalesce(li.cites_ok, true)) AS hidden,
          (SELECT count(*) FROM li WHERE NOT coalesce(li.cites_ok, true) AND coalesce(li.person_locked, false)) AS hidden_locked) x
 ),
 -- money totals
 mt AS (
  SELECT coalesce(sum(mo.invoiced), 0) AS invoiced, coalesce(sum(mo.paid), 0) AS paid, coalesce(sum(mo.credited), 0) AS credited,
         coalesce(sum(mo.owing), 0) AS owing, coalesce(sum(mo.overdue), 0) AS overdue, min(mo.oldest_overdue_due) AS oldest_overdue,
         coalesce(sum(mo.drafts), 0) AS drafts, coalesce(sum(mo.draft_total), 0) AS draft_total,
         max(mo.job_value) AS job_value, max(mo.job_value_basis) AS job_value_basis, max(mo.not_yet_invoiced) AS nyi,
         count(*) FILTER (WHERE mo.party IS NOT NULL) AS parties,
         (SELECT m2.supplier_bills FROM mo m2 LIMIT 1) AS bills
  FROM mo
 ),
 -- evidence for the phase
 -- the newest standing crew booking up to today, and whether one is still ahead:
 -- work is done only when that booking is complete and nothing is ahead (a booking
 -- stands unless cancelled, deleted, draft, disputed or declined; crew planning's
 -- confirmation is never read)
 bkn AS (
  SELECT (SELECT to_jsonb(b) FROM bk b, inp WHERE b.scheduled_date <= inp.today
            AND lower(coalesce(b.status, '')) NOT IN ('cancelled', 'deleted', 'draft', 'disputed', 'declined')
          ORDER BY b.scheduled_date DESC, b.id COLLATE "C" DESC LIMIT 1) AS nb,
         EXISTS (SELECT 1 FROM bk b, inp WHERE b.scheduled_date > inp.today
                   AND lower(coalesce(b.status, '')) NOT IN ('cancelled', 'deleted', 'draft', 'disputed', 'declined')) AS ahead
 ),
 ev AS (
  SELECT
   -- attendance timed as a closing reads it: completed, else started, else (a
   -- status-only completion) the end of the booked Perth day, or now while that is ahead
   (SELECT CASE WHEN NOT bkn.ahead AND bkn.nb IS NOT NULL
                 AND (lower(coalesce(bkn.nb->>'status', '')) IN ('complete', 'completed') OR bkn.nb->>'completed_at' IS NOT NULL)
            THEN (SELECT max(coalesce(b.completed_at, b.started_at,
                                      least(((b.scheduled_date + 1)::timestamp AT TIME ZONE 'Australia/Perth') - interval '1 second', now()))) FROM bk b
                  WHERE lower(coalesce(b.status, '')) IN ('complete', 'completed') OR b.completed_at IS NOT NULL) END FROM bkn) AS done_at,
   (SELECT bkn.ahead FROM bkn) AS bk_ahead,
   -- a passed booking nobody marked started or complete
   (SELECT (bkn.nb->>'scheduled_date')::date FROM bkn, inp
    WHERE bkn.nb IS NOT NULL AND (bkn.nb->>'scheduled_date')::date < inp.today
      AND lower(coalesce(bkn.nb->>'status', '')) NOT IN ('complete', 'completed', 'in_progress')
      AND bkn.nb->>'completed_at' IS NULL AND bkn.nb->>'started_at' IS NULL) AS unattended_on,
   (SELECT min(coalesce(b.completed_at, b.started_at, b.scheduled_date::timestamp AT TIME ZONE 'Australia/Perth')) FROM bk b
    WHERE b.status IN ('complete', 'in_progress') OR b.completed_at IS NOT NULL OR b.started_at IS NOT NULL) AS started_at,
   (inp.rec->'facts'->>'report_sent_at')::timestamptz AS report_sent_at,
   (SELECT to_jsonb(b) FROM bk b WHERE b.scheduled_date >= inp.today
      AND lower(coalesce(b.status, '')) NOT IN ('cancelled', 'deleted', 'draft', 'disputed', 'declined', 'complete', 'completed')
    ORDER BY b.scheduled_date, b.id COLLATE "C" LIMIT 1) AS next_bk,
   (SELECT min(q.accepted_at) FROM qd q) AS accepted_at,
   (SELECT min(q.sent_at) FROM qd q) AS first_sent,
   (SELECT max(q.sent_at) FROM qd q) AS last_sent,
   (SELECT min(t.at) FROM tl t WHERE t.kind = 'site_visit') AS scoped_at,
   (SELECT max(t.at) FROM tl t WHERE t.kind IN ('status', 'rectification') AND t.time_basis = 'observed') AS status_at,
   inp.job->>'status' AS status, inp.job->>'type' AS type, inp.today
  FROM inp
 ),
 ph0 AS (
  SELECT ev.*,
   CASE ev.status
    WHEN 'quoted' THEN 'quote' WHEN 'accepted' THEN 'accepted' WHEN 'partially_accepted' THEN 'accepted'
    WHEN 'awaiting_deposit' THEN 'deposit' WHEN 'deposit' THEN 'deposit' WHEN 'approvals' THEN 'approvals'
    WHEN 'order_materials' THEN 'materials' WHEN 'awaiting_supplier' THEN 'materials' WHEN 'schedule_install' THEN 'scheduled'
    WHEN 'scheduled' THEN 'scheduled' WHEN 'in_progress' THEN 'install' WHEN 'invoiced' THEN 'invoice'
    WHEN 'final_payment' THEN 'payment' WHEN 'get_review' THEN 'complete' WHEN 'complete' THEN 'complete'
    WHEN 'completed' THEN 'complete' WHEN 'rectification' THEN 'rectification' WHEN 'lead' THEN 'enquiry' WHEN 'new' THEN 'enquiry'
    WHEN 'processing' THEN CASE WHEN ev.type = 'makesafe' THEN 'makesafe' ELSE 'other' END
    ELSE 'other' END AS status_phase,
   CASE WHEN ev.bk_ahead THEN NULL ELSE coalesce(ev.done_at, ev.report_sent_at) END AS work_done_at,
   (mt.owing > 0) AS owing, (coalesce(mt.nyi, 0) > 1) AS uninvoiced
  FROM ev, mt
 ),
 ph AS (
  SELECT p.*,
   CASE
    WHEN p.status_phase = 'rectification' THEN 'rectification'
    WHEN p.started_at IS NOT NULL AND p.next_bk IS NOT NULL THEN 'install'
    WHEN p.unattended_on IS NOT NULL AND p.work_done_at IS NULL THEN 'install'
    WHEN p.work_done_at IS NOT NULL AND p.owing THEN 'payment'
    WHEN p.work_done_at IS NOT NULL AND p.uninvoiced THEN 'invoice'
    WHEN p.work_done_at IS NOT NULL THEN 'complete'
    WHEN p.status_phase IN ('install', 'complete', 'invoice', 'payment') THEN p.status_phase
    WHEN p.type = 'makesafe' THEN 'makesafe'
    WHEN p.next_bk IS NOT NULL THEN 'scheduled'
    ELSE (SELECT x.ph FROM (VALUES
           (CASE WHEN p.accepted_at IS NOT NULL THEN 'accepted' WHEN p.first_sent IS NOT NULL THEN 'quote'
                 WHEN p.scoped_at IS NOT NULL THEN 'scope' ELSE 'enquiry' END), (p.status_phase)) x(ph)
          ORDER BY array_position(ARRAY['other','enquiry','scope','quote','accepted','deposit','approvals','materials','scheduled'], x.ph) DESC NULLS LAST
          LIMIT 1)
   END AS phase
  FROM ph0 p
 ),
 phs AS (
  SELECT ph.*,
   CASE
    WHEN ph.phase = 'install' THEN coalesce(ph.started_at, ph.unattended_on::timestamp AT TIME ZONE 'Australia/Perth')
    WHEN ph.phase IN ('payment', 'invoice', 'complete') AND ph.work_done_at IS NOT NULL THEN ph.work_done_at
    WHEN ph.phase = 'scheduled' AND ph.next_bk IS NOT NULL
     THEN CASE WHEN ph.status_phase = 'scheduled' THEN coalesce(ph.status_at, (ph.next_bk->>'created_at')::timestamptz)
               ELSE (ph.next_bk->>'created_at')::timestamptz END
    WHEN ph.phase = 'accepted' THEN coalesce(ph.accepted_at, ph.status_at)
    WHEN ph.phase = 'quote' THEN coalesce(ph.last_sent, ph.status_at)
    WHEN ph.phase = 'scope' THEN ph.scoped_at
    WHEN ph.phase = ph.status_phase THEN ph.status_at
   END AS phase_since_at
  FROM ph
 ),
 -- R5 / C11 candidates, and whether a visible open ledger item says a reply is owed
 cand AS (
  SELECT r.*, (SELECT v.item_key FROM vis v
               WHERE v.status = 'open' AND (coalesce(v.needs_reply, false) OR v.item_type = 'request')
                 AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(v.cited, v.opened_by)) c
                             WHERE (c->>'id' = r.source_id)
                                OR (coalesce((c->>'customer')::boolean, false) AND (c->>'at')::timestamptz >= r.opened_at))
               ORDER BY v.opened_at, v.item_key COLLATE "C" LIMIT 1) AS promoted_by
  FROM rl r WHERE r.shown_as = 'candidate'
 ),
 -- record loops shown as loops, merged per object (about_key), with promoted candidates
 rec AS (
  SELECT r.rule, r.loop_key, r.owner, r.counterparty, r.what, r.why, r.opened_at, r.due_date, r.amount, r.about_key, r.closes_when,
         r.source_table, r.source_id, NULL::text AS promoted_by
  FROM rl r WHERE r.shown_as = 'loop'
  UNION ALL
  SELECT c.rule, c.loop_key, c.owner, c.counterparty, c.what, c.why, c.opened_at, c.due_date, c.amount, c.about_key, c.closes_when,
         c.source_table, c.source_id, c.promoted_by
  FROM cand c WHERE c.promoted_by IS NOT NULL
 ),
 recg AS (
  SELECT r.about_key,
         (array_agg(r.loop_key ORDER BY array_position(ARRAY['R1_overdue','M1_money_due','R2_part_paid','R3_draft','R8_not_yet_invoiced',
                    'R4_missed_call','R5_customer_wrote_last','C11_customer_mail_unanswered','R7_quote_waiting'], r.rule) NULLS LAST, r.loop_key COLLATE "C"))[1] AS key,
         (array_agg(r.rule ORDER BY array_position(ARRAY['R1_overdue','M1_money_due','R2_part_paid','R3_draft','R8_not_yet_invoiced',
                    'R4_missed_call','R5_customer_wrote_last','C11_customer_mail_unanswered','R7_quote_waiting'], r.rule) NULLS LAST, r.loop_key COLLATE "C"))[1] AS rule,
         string_agg(DISTINCT r.rule COLLATE "C", '+' ORDER BY r.rule COLLATE "C") AS rules,
         (array_agg(r.owner ORDER BY array_position(ARRAY['R1_overdue','M1_money_due','R2_part_paid','R3_draft','R8_not_yet_invoiced'], r.rule) NULLS LAST, r.loop_key COLLATE "C"))[1] AS owner,
         (array_agg(r.counterparty ORDER BY array_position(ARRAY['R1_overdue','M1_money_due','R2_part_paid','R3_draft','R8_not_yet_invoiced'], r.rule) NULLS LAST, r.loop_key COLLATE "C"))[1] AS counterparty,
         (array_agg(r.what ORDER BY array_position(ARRAY['R1_overdue','M1_money_due','R2_part_paid','R3_draft','R8_not_yet_invoiced'], r.rule) NULLS LAST, r.loop_key COLLATE "C"))[1] AS what,
         string_agg(r.why, '; ' ORDER BY r.rule COLLATE "C", r.loop_key COLLATE "C") AS why,
         min(r.opened_at) AS since, min(r.due_date) AS due, max(r.amount) AS amount,
         (array_agg(r.closes_when ORDER BY r.rule COLLATE "C", r.loop_key COLLATE "C"))[1] AS closes_when,
         jsonb_agg(DISTINCT jsonb_build_object('t', r.source_table, 'id', r.source_id)) AS cites,
         array_agg(r.promoted_by) FILTER (WHERE r.promoted_by IS NOT NULL) AS promoted_by
  FROM rec r GROUP BY r.about_key
 ),
 -- open ledger items that are loops
 lop AS (
  SELECT v.* FROM vis v
  WHERE v.status = 'open'
    AND (v.item_type IN ('commitment', 'request', 'claim', 'issue', 'constraint', 'dependency')
         OR (v.item_type = 'agreement' AND v.modality IN ('requested', 'offered')))
 ),
 -- which ledger items attach to a record loop (same object, or the item that promoted a candidate)
 att AS (
  SELECT l.item_key, g.about_key AS loop_about
  FROM lop l JOIN recg g ON g.about_key = l.about_key OR l.item_key = ANY (coalesce(g.promoted_by, '{}'::text[]))
 ),
 lrole AS (
  SELECT l.*,
   CASE
    WHEN l.item_type = 'commitment' THEN l.from_role
    WHEN l.item_type = 'request' THEN coalesce(l.to_role, 'us')
    WHEN l.item_type = 'dependency' THEN CASE WHEN coalesce(l.to_role, 'third_party') IN ('us', 'crew') THEN 'third_party' ELSE l.to_role END
    WHEN l.item_type = 'agreement' THEN CASE WHEN l.from_role IN ('us', 'crew') THEN coalesce(l.to_role, 'customer') ELSE 'us' END
    ELSE 'us' END AS owner_role,
   CASE
    WHEN l.item_type = 'commitment' THEN l.from_name
    WHEN l.item_type = 'request' THEN l.to_name
    WHEN l.item_type = 'dependency' THEN l.to_name
    WHEN l.item_type = 'agreement' THEN CASE WHEN l.from_role IN ('us', 'crew') THEN l.to_name ELSE NULL END
   END AS owner_name,
   CASE
    WHEN l.item_type = 'commitment' THEN l.to_role
    WHEN l.item_type IN ('request', 'claim', 'issue', 'constraint') THEN l.from_role
    WHEN l.item_type = 'agreement' THEN CASE WHEN l.from_role IN ('us', 'crew') THEN 'us' ELSE l.from_role END
    ELSE 'us' END AS counter_role,
   (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(l.opened_by) c) AS cites,
   (SELECT c->>'excerpt' FROM jsonb_array_elements(l.opened_by) c LIMIT 1) AS excerpt,
   (SELECT jsonb_agg(jsonb_build_object('t', x.t, 'id', x.id, 'what', x.what) ORDER BY x.at, x.t COLLATE "C", x.id COLLATE "C")
    FROM cc x
    WHERE l.closes_on IN ('quote_sent', 'invoice_issued', 'payment', 'booking_made', 'visit') AND x.closes_on = l.closes_on
      AND x.at > l.opened_at
      -- exact object only: a slug (quote:rear-fence) never matches some other quote by prefix
      AND x.about_key = l.about_key) AS closing
  FROM lop l
 ),
 norm AS (  -- role words to the loop owner vocabulary
  SELECT r.*,
   CASE WHEN r.owner_role IN ('us', 'crew') THEN 'us' WHEN r.owner_role IN ('customer', 'insurer_builder') THEN 'customer'
        WHEN r.owner_role IN ('supplier', 'third_party') THEN 'third_party' ELSE 'unknown' END AS owner,
   CASE WHEN r.counter_role IN ('us', 'crew') THEN 'us' WHEN r.counter_role IN ('customer', 'insurer_builder') THEN 'customer'
        WHEN r.counter_role IN ('supplier', 'third_party') THEN 'third_party' ELSE 'unknown' END AS counterparty
  FROM lrole r
 ),
 loops0 AS (
  -- record loops (with attached ledger items)
  SELECT g.key, 'record'::text AS source, g.rules AS rule, g.owner, NULL::text AS owner_name, g.counterparty,
         g.what,
         concat_ws('; ', g.why, (SELECT string_agg(n.what || coalesce(' ("' || left(n.excerpt, 160) || '")', ''), '; ' ORDER BY n.opened_at, n.item_key COLLATE "C")
                                 FROM norm n JOIN att a ON a.item_key = n.item_key AND a.loop_about = g.about_key)) AS why,
         g.since, coalesce(g.due, (SELECT min(n.due_date) FROM norm n JOIN att a ON a.item_key = n.item_key AND a.loop_about = g.about_key)) AS due,
         -- the record rule still fires, so the loop is open: closing evidence is shown on ledger items only
         'open'::text AS status,
         g.closes_when,
         (SELECT max(n.blocks) FROM norm n JOIN att a ON a.item_key = n.item_key AND a.loop_about = g.about_key WHERE n.blocks <> 'none') AS blocks,
         NULL::jsonb AS closing_evidence,
         (SELECT jsonb_agg(d.c ORDER BY d.c ->> 't' COLLATE "C" NULLS FIRST, d.c ->> 'id' COLLATE "C" NULLS FIRST)
          FROM (SELECT DISTINCT c FROM jsonb_array_elements(g.cites || coalesce((SELECT jsonb_agg(c2) FROM norm n
                JOIN att a ON a.item_key = n.item_key AND a.loop_about = g.about_key, jsonb_array_elements(n.cites) c2), '[]'::jsonb)) c) d) AS cites,
         g.about_key, g.amount,
         (g.rule IN ('R4_missed_call', 'R5_customer_wrote_last', 'C11_customer_mail_unanswered')) AS customer_waiting,
         (g.rule IN ('R1_overdue', 'M1_money_due', 'R2_part_paid', 'R3_draft', 'R8_not_yet_invoiced')) AS money
  FROM recg g
  UNION ALL
  -- ledger loops not attached to a record loop
  SELECT n.item_key, CASE WHEN n.written_by LIKE 'person:%' THEN 'person' ELSE 'ledger' END, n.item_type, n.owner, n.owner_name,
         n.counterparty, n.what, coalesce('"' || left(n.excerpt, 200) || '"', NULL), n.opened_at, n.due_date,
         CASE WHEN n.closing IS NOT NULL THEN 'closing_evidence' ELSE 'open' END,
         CASE n.closes_on WHEN 'reply' THEN 'A reply that answers it' WHEN 'call' THEN 'A call that deals with it'
              WHEN 'quote_sent' THEN 'The quote is sent' WHEN 'invoice_issued' THEN 'The invoice is issued'
              WHEN 'payment' THEN 'The payment is received' WHEN 'booking_made' THEN 'A booking is made'
              WHEN 'visit' THEN 'The visit happens' WHEN 'work_done' THEN 'The work is done' WHEN 'record' THEN 'A record shows it done'
              WHEN 'person' THEN 'A person closes it' ELSE 'Words or a record that show it done' END,
         nullif(n.blocks, 'none'), n.closing, coalesce(n.cites, '[]'::jsonb), n.about_key, NULL::numeric,
         (n.owner = 'us' AND n.counterparty = 'customer' AND (coalesce(n.needs_reply, false) OR n.item_type = 'request')),
         (n.blocks IN ('payment', 'deposit') OR n.about_key LIKE 'invoice:%' OR n.about_key LIKE 'payment:%')
  FROM norm n WHERE NOT EXISTS (SELECT 1 FROM att a WHERE a.item_key = n.item_key)
 ),
 loops AS (
  SELECT l.*, (inp.today - (l.since AT TIME ZONE 'Australia/Perth')::date) AS age_days,
         row_number() OVER (ORDER BY
           CASE WHEN l.owner = 'us' AND l.customer_waiting THEN 0 WHEN l.money THEN 1 WHEN l.owner = 'us' THEN 2 ELSE 3 END,
           l.since NULLS LAST, l.key COLLATE "C") AS rank
  FROM loops0 l, inp
 ),
 -- unpromoted R5 / C11 candidates, and whether the reading shown has read the row
 -- (the row is in its read set: admitted to its evidence and landed by its evidence_until)
 wr AS (
  SELECT c.*, (led.gen IS NOT NULL AND coalesce(led.read_ids ? c.source_id, false)) AS read_by_reader
  FROM cand c, led WHERE c.promoted_by IS NULL
 ),
 -- the customer wrote last and nobody has read it yet: the now line and whose move say so
 -- the newest unread candidate, and where its message sits (mail the old inbox placed
 -- on no job is said to be so)
 wl AS (SELECT w.opened_at AS at, w.placement FROM wr w WHERE NOT w.read_by_reader ORDER BY w.opened_at DESC, w.source_id COLLATE "C" DESC LIMIT 1),
 -- checks: record checks, plus candidates nobody promoted
 checks AS (
  SELECT r.rule, r.what, jsonb_build_array(jsonb_build_object('t', r.source_table, 'id', r.source_id)) AS cites, r.opened_at
  FROM rl r WHERE r.shown_as = 'check'
  UNION ALL
  SELECT c.rule,
         CASE WHEN c.read_by_reader
              THEN 'Customer wrote last; the reader judged no reply is needed. ' || c.what
              ELSE 'Customer wrote last; not yet read by the reader. ' || c.what END,
         jsonb_build_array(jsonb_build_object('t', c.source_table, 'id', c.source_id)), c.opened_at
  FROM wr c
 ),
 top AS (SELECT l.* FROM loops l ORDER BY l.rank LIMIT 1),
 -- whose move: ours when we owe something; unclear while the customer wrote last unread
 wm AS (
  SELECT CASE
          WHEN EXISTS (SELECT 1 FROM loops l WHERE l.owner = 'us') THEN 'us'
          WHEN EXISTS (SELECT 1 FROM wl) THEN 'unknown'
          WHEN EXISTS (SELECT 1 FROM loops l WHERE l.owner = 'customer') THEN 'customer'
          WHEN EXISTS (SELECT 1 FROM loops l WHERE l.owner = 'third_party') THEN 'third_party'
          WHEN EXISTS (SELECT 1 FROM loops l) THEN 'unknown'
          ELSE 'nobody' END AS whose
 ),
 -- day words: Perth dates like "Wed 7 Oct" (year added when it is not the current year)
 nx AS (
  SELECT phs.next_bk AS b,
         CASE WHEN phs.next_bk IS NULL THEN NULL
              ELSE to_char((phs.next_bk->>'scheduled_date')::date, 'Dy FMDD Mon')
                   || CASE WHEN extract(year FROM (phs.next_bk->>'scheduled_date')::date) <> extract(year FROM phs.today)
                           THEN ' ' || extract(year FROM (phs.next_bk->>'scheduled_date')::date) ELSE '' END END AS day
  FROM phs
 ),
 nowp AS (
  SELECT phs.phase, phs.phase_since_at,
   -- phase words say where the job is, never whose move it is (the move words do);
   -- invoicing and payment words follow the money, not the status
   CASE phs.phase
    WHEN 'enquiry' THEN 'New enquiry' WHEN 'scope' THEN 'Scoping' WHEN 'quote' THEN 'Quoted'
    WHEN 'accepted' THEN 'Accepted' WHEN 'deposit' THEN 'Deposit stage' WHEN 'approvals' THEN 'In approvals'
    WHEN 'materials' THEN 'Materials being ordered' WHEN 'scheduled' THEN 'Scheduled' WHEN 'install' THEN 'Install under way'
    WHEN 'complete' THEN 'Work complete'
    WHEN 'invoice' THEN CASE WHEN phs.uninvoiced AND phs.work_done_at IS NOT NULL THEN 'Work done, not fully invoiced'
                             WHEN phs.uninvoiced THEN 'Not fully invoiced' ELSE 'Invoiced' END
    WHEN 'payment' THEN CASE WHEN phs.owing AND phs.work_done_at IS NOT NULL THEN 'Work done, payment owing'
                             WHEN phs.owing THEN 'Payment owing' ELSE 'Final payment stage' END
    WHEN 'rectification' THEN 'In rectification'
    WHEN 'makesafe' THEN 'Make-safe in progress' ELSE 'In progress' END
   || coalesce(' since ' || to_char((phs.phase_since_at AT TIME ZONE 'Australia/Perth')::date, 'Dy FMDD Mon')
               || CASE WHEN extract(year FROM (phs.phase_since_at AT TIME ZONE 'Australia/Perth')) <> extract(year FROM phs.today)
                       THEN ' ' || extract(year FROM (phs.phase_since_at AT TIME ZONE 'Australia/Perth')) ELSE '' END, '') AS phase_words,
   CASE WHEN nx.b IS NOT NULL THEN 'next visit ' || coalesce(replace(nx.b->>'assignment_type', '_', ' ') || ' ', '') || 'booked ' || nx.day END AS next_words,
   CASE WHEN phs.phase = 'install' AND phs.unattended_on IS NOT NULL
        THEN 'attendance not recorded for ' || to_char(phs.unattended_on, 'Dy FMDD Mon')
             || CASE WHEN extract(year FROM phs.unattended_on) <> extract(year FROM phs.today) THEN ' ' || extract(year FROM phs.unattended_on) ELSE '' END
   END AS att_words,
   (SELECT CASE WHEN t.owner = 'us' THEN 'we owe: ' WHEN t.owner = 'customer' THEN 'the customer owes: '
                WHEN t.owner = 'third_party' THEN 'waiting on another party: ' ELSE 'open: ' END
           || left(regexp_replace(t.what, '\s+', ' ', 'g'), 140) FROM top t) AS top_words,
   CASE WHEN mt.owing > 0 THEN 'owing ' || to_char(mt.owing, 'FM$999,999,990.00')
            || CASE WHEN mt.overdue > 0 THEN ' (' || to_char(mt.overdue, 'FM$999,999,990.00') || ' overdue)' ELSE '' END END AS owing_words,
   CASE WHEN mt.drafts > 0 THEN mt.drafts || CASE WHEN mt.drafts = 1 THEN ' draft invoice' ELSE ' draft invoices' END || ' not issued' END AS draft_words,
   CASE WHEN coalesce(mt.nyi, 0) > 1 THEN to_char(mt.nyi, 'FM$999,999,990.00') || ' not yet invoiced' END AS nyi_words,
   CASE wm.whose WHEN 'us' THEN 'Our move' WHEN 'customer' THEN 'The customer''s move'
        WHEN 'third_party' THEN 'Waiting on another party' WHEN 'unknown' THEN 'Whose move is unclear'
        ELSE CASE WHEN nx.b IS NOT NULL THEN 'Nothing open until the visit' ELSE 'Nothing open on record' END END AS move_words,
   (SELECT 'the customer wrote last on ' || to_char((wl.at AT TIME ZONE 'Australia/Perth')::date, 'Dy FMDD Mon')
           || CASE WHEN extract(year FROM (wl.at AT TIME ZONE 'Australia/Perth')) <> extract(year FROM phs.today)
                   THEN ' ' || extract(year FROM (wl.at AT TIME ZONE 'Australia/Perth')) ELSE '' END
           || CASE WHEN wl.placement = 'not_placed' THEN ' (an email not placed on any job)' ELSE '' END
           || '; not read yet' FROM wl) AS wrote_words
  FROM phs, nx, mt, wm
 ),
 nowl AS (
  SELECT n.*, (SELECT string_agg(upper(left(x.s, 1)) || substr(x.s, 2), '. ' ORDER BY x.o) FROM (VALUES
           (1, n.phase_words || coalesce(': ' || n.next_words, '') || coalesce('; ' || n.att_words, '')),
           (2, nullif(concat_ws(', ', n.owing_words, n.draft_words, n.nyi_words), '')),
           (3, n.move_words || coalesce(', ' || n.top_words, '')),
           (4, n.wrote_words)) x(o, s) WHERE x.s IS NOT NULL) AS line0
  FROM nowp n
 ),
 nowline AS (
  SELECT n.*, CASE WHEN length(n.line0) <= 399 THEN n.line0 || CASE WHEN n.line0 ~ '[.!?"]$' THEN '' ELSE '.' END
                   ELSE left(n.line0, 396 - position(' ' IN reverse(left(n.line0, 396)))) || '...' END AS line
  FROM nowl n
 ),
 blockers AS (  -- in loop rank order, then the drafts by loop key
  SELECT l.what, l.cites, l.rank AS o, l.key AS k FROM loops l WHERE l.blocks IS NOT NULL
  UNION ALL
  SELECT r.what, jsonb_build_array(jsonb_build_object('t', r.source_table, 'id', r.source_id)), NULL::bigint, r.loop_key
  FROM rl r WHERE r.rule = 'R3_draft'
 ),
 -- not known
 nk AS (
  SELECT x.what, x.why, x.ord FROM inp, led, LATERAL (VALUES
   (1, CASE WHEN coalesce((inp.meta->'lanes'->>'texts')::int, 0) = 0 THEN 'No texts are on record for this job.' END,
       'Texts reach a job only through its CRM contact or a job reference.'),
   (2, CASE WHEN coalesce((inp.meta->'lanes'->>'emails')::int, 0) = 0 THEN 'No emails are on record for this job.' END,
       'Emails reach a job by thread, sender or job reference.'),
   (3, CASE WHEN coalesce((inp.meta->'lanes'->>'calls')::int, 0) = 0 THEN 'No calls are on record for this job.' END,
       'Only calls logged by the phone system are captured.'),
   (4, CASE WHEN coalesce((inp.meta->'lanes'->>'documents')::int, 0) = 0 THEN 'No documents have been read into evidence for this job.' END,
       'Only documents whose text was extracted are evidence.'),
   (5, CASE WHEN (inp.meta->>'history_start')::timestamptz > (inp.job->>'created_at')::timestamptz + interval '2 days'
            THEN 'Message history on record starts ' || to_char(((inp.meta->>'history_start')::timestamptz AT TIME ZONE 'Australia/Perth')::date, 'Dy FMDD Mon YYYY')
                 || ', after the job began ' || to_char(((inp.job->>'created_at')::timestamptz AT TIME ZONE 'Australia/Perth')::date, 'Dy FMDD Mon YYYY') || '.' END,
       'Earlier messages were not captured.'),
   (6, CASE WHEN led.gen IS NOT NULL AND coalesce(led.unread, 0) > 0
            THEN led.unread || CASE WHEN led.unread = 1 THEN ' newer message on this job has' ELSE ' newer messages on this job have' END
                 || ' not been read by the reader yet.' END,
       'The reader reads new evidence on its own schedule.'),
   (7, CASE WHEN coalesce((inp.meta->'unplaced'->>'count')::int, 0) > 0
            THEN (inp.meta->'unplaced'->>'count') || CASE WHEN (inp.meta->'unplaced'->>'count')::int = 1 THEN ' message' ELSE ' messages' END
                 || ' from this customer are not placed on any job yet.' END,
       'They may belong to this job; they wait in the placement queue.'),
   (7, CASE WHEN coalesce((inp.meta->'withheld_mail'->>'count')::int, 0) > 0
            THEN (inp.meta->'withheld_mail'->>'count') || CASE WHEN (inp.meta->'withheld_mail'->>'count')::int = 1
                 THEN ' email from this customer is not placed on any job; it may belong to another of their jobs.'
                 ELSE ' emails from this customer are not placed on any job; they may belong to another of their jobs.' END END,
       'This customer has more than one job, so mail the old inbox placed on no job is kept off each of them.'),
   (8, CASE WHEN EXISTS (SELECT 1 FROM rl r WHERE r.rule = 'C4_booking_attendance_unrecorded')
            THEN 'Attendance is not recorded for a booking that has passed.' END,
       'The crew did not mark it started or complete.'),
   (9, CASE WHEN led.status = 'none' THEN 'No reader has read this job''s messages yet, so promises, requests and agreements in the words are not shown.'
            WHEN led.status IN ('shadow', 'building') AND led.gen IS NULL THEN 'The reader''s ledger for this job is not live yet, so the words are not shown.' END,
       'The ledger is written by the reader and shown once live.'),
   (10, CASE WHEN led.hidden - led.hidden_locked > 0 THEN (led.hidden - led.hidden_locked)
             || CASE WHEN led.hidden - led.hidden_locked = 1 THEN ' reader item was' ELSE ' reader items were' END
             || ' hidden because messages it cited moved off this job; the story needs a rebuild.' END,
        'A ledger item is shown only while every message it cites is still on this job.'),
   (14, CASE WHEN led.hidden_locked > 0 THEN led.hidden_locked
             || CASE WHEN led.hidden_locked = 1 THEN ' staff correction cites a message' ELSE ' staff corrections cite messages' END
             || ' that moved off this job; a person needs to check '
             || CASE WHEN led.hidden_locked = 1 THEN 'it.' ELSE 'them.' END END,
        'A rebuild keeps staff corrections as they are, so only a person can fix this.'),
   (11, CASE WHEN coalesce((inp.meta->>'contact_missing')::boolean, false) THEN 'This job has no CRM contact, so texts and calls may not reach it.' END,
        'Texts and calls are placed by the CRM contact.'),
   (12, CASE WHEN led.status = 'shadow' AND led.gen IS NOT NULL THEN 'This story shows a shadow reading that is not live yet.'
             WHEN led.gen IS NOT NULL AND led.gen->>'status' IN ('failed', 'retired', 'building')
             THEN 'This story shows a ' || (led.gen->>'status') || ' reading, not the live one.' END,
        'A shadow generation is checked before it is promoted; a failed, retired or unfinished one is never shown by default.'),
   (13, 'Phone calls that were not recorded are not here.', 'Only calls the phone system logged are captured.')
  ) x(ord, what, why)
  WHERE x.what IS NOT NULL
 ),
 -- who
 who AS (
  SELECT DISTINCT ON (lower(w.name), w.role) w.name, w.role, w.contact_ref, w.cites, w.ord FROM (
   SELECT inp.job->>'client_name' AS name, CASE WHEN inp.job->>'type' = 'makesafe' THEN 'insured' ELSE 'customer' END AS role,
          inp.job->>'ghl_contact_id' AS contact_ref, jsonb_build_array(jsonb_build_object('t', 'jobs', 'id', inp.job->>'id')) AS cites, 1 AS ord
   FROM inp WHERE nullif(btrim(inp.job->>'client_name'), '') IS NOT NULL
   UNION ALL
   SELECT m.party, 'payer', m.xero_contact_id,
          (SELECT jsonb_agg(jsonb_build_object('t', 'xero_invoices', 'id', i->>'id')) FROM jsonb_array_elements(m.invoices) i), 2
   FROM mo m WHERE m.party IS NOT NULL  -- a payer has an issued invoice; drafts alone make nobody a payer
     AND (coalesce(m.invoiced, 0) > 0 OR coalesce(m.paid, 0) > 0 OR coalesce(m.credited, 0) > 0)
   UNION ALL
   SELECT p->>'name', coalesce(p->>'role', 'party'), p->>'contact_ref', jsonb_build_array(jsonb_build_object('t', 'job_contacts', 'id', p->>'id')), 3
   FROM inp, jsonb_array_elements(coalesce(inp.rec->'facts'->'parties', '[]'::jsonb)) p WHERE nullif(btrim(p->>'name'), '') IS NOT NULL
   UNION ALL
   SELECT n.nm, n.rl, NULL, (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(n.ob) c), 4
   FROM (SELECT v.from_name AS nm, v.from_role AS rl, v.opened_by AS ob FROM vis v WHERE v.status NOT IN ('disputed', 'superseded', 'declined')
         UNION ALL SELECT v.to_name, v.to_role, v.opened_by FROM vis v WHERE v.status NOT IN ('disputed', 'superseded', 'declined')) n
   WHERE nullif(btrim(n.nm), '') IS NOT NULL
  ) w ORDER BY lower(w.name), w.role, w.ord, w.name COLLATE "C", w.contact_ref COLLATE "C", w.cites::text COLLATE "C"
 ),
 cm AS (
  SELECT
   (SELECT count(*) FROM vis v WHERE v.item_type = 'commitment' AND v.status = 'closed' AND (v.due_date IS NULL OR (v.closed_at AT TIME ZONE 'Australia/Perth')::date <= v.due_date)) AS kept,
   (SELECT count(*) FROM vis v WHERE v.item_type = 'commitment' AND v.status = 'closed' AND v.due_date IS NOT NULL AND (v.closed_at AT TIME ZONE 'Australia/Perth')::date > v.due_date) AS late,
   (SELECT count(*) FROM vis v, inp WHERE v.item_type = 'commitment' AND v.status = 'open' AND (v.due_date IS NULL OR v.due_date >= inp.today)) AS open_,
   (SELECT count(*) FROM vis v, inp WHERE v.item_type = 'commitment' AND v.status = 'open' AND v.due_date < inp.today) AS overdue
 ),
 tlout AS (
  SELECT t.*,
   CASE t.kind WHEN 'quote' THEN 'quote' WHEN 'invoice' THEN 'invoice' WHEN 'payment' THEN 'payment' WHEN 'credit' THEN 'payment'
        WHEN 'booking' THEN 'scheduled' WHEN 'attendance' THEN 'install' WHEN 'site_visit' THEN 'scope' WHEN 'first_contact' THEN 'enquiry'
        WHEN 'job_created' THEN 'enquiry' WHEN 'rectification' THEN 'rectification' WHEN 'makesafe' THEN 'makesafe' END AS phase
  FROM tl t WHERE t.kind <> 'booking_mirror'
 )
 SELECT jsonb_build_object(
  'version', 'job-story-v1',
  'job', (SELECT jsonb_build_object('id', inp.job->'id', 'job_number', inp.job->'job_number', 'type', inp.job->'type',
                 'status', inp.job->'status', 'client_name', inp.job->'client_name', 'site_suburb', inp.job->'site_suburb',
                 'created_at', inp.job->'created_at') FROM inp),
  'as_of', (SELECT inp.as_of FROM inp),
  'now', (SELECT jsonb_build_object(
            'line', n.line, 'phase', n.phase,
            'phase_since', (n.phase_since_at AT TIME ZONE 'Australia/Perth')::date,
            'whose_move', (SELECT wm.whose FROM wm),
            'next', CASE WHEN (SELECT nx.b FROM nx) IS NOT NULL
                         THEN (SELECT jsonb_build_object('what', 'Visit booked: ' || replace(coalesce(nx.b->>'assignment_type', 'visit'), '_', ' ')
                                                         || coalesce(' (' || nullif(btrim(nx.b->>'crew_name'), '') || ')', ''),
                                                         'when', nx.b->'scheduled_date', 'day', nx.day,
                                                         'cites', jsonb_build_array(jsonb_build_object('t', 'job_assignments', 'id', nx.b->>'id'))) FROM nx)
                         WHEN EXISTS (SELECT 1 FROM top)
                         THEN (SELECT jsonb_build_object('what', t.what, 'when', t.due, 'cites', t.cites) FROM top t) END,
            'blockers', coalesce((SELECT jsonb_agg(jsonb_build_object('what', b.what, 'cites', b.cites) ORDER BY b.o NULLS LAST, b.k COLLATE "C")
                                  FROM blockers b), '[]'::jsonb),
            'cites', coalesce((SELECT jsonb_agg(d.c ORDER BY d.c ->> 't' COLLATE "C" NULLS FIRST, d.c ->> 'id' COLLATE "C" NULLS FIRST)
                       FROM (SELECT DISTINCT z.c FROM (
                       SELECT c FROM top t, jsonb_array_elements(t.cites) c
                       UNION ALL SELECT jsonb_build_object('t', 'job_assignments', 'id', nx.b->>'id') FROM nx WHERE nx.b IS NOT NULL
                       UNION ALL SELECT jsonb_build_object('t', 'jobs', 'id', inp.job->>'id') FROM inp) z) d), '[]'::jsonb))
          FROM nowline n),
  'money', (SELECT jsonb_build_object(
             'line', CASE WHEN mt.invoiced = 0 AND mt.drafts = 0 THEN 'No invoices issued'
                          ELSE 'Invoiced ' || to_char(mt.invoiced, 'FM$999,999,990.00') || ', paid ' || to_char(mt.paid, 'FM$999,999,990.00')
                               || CASE WHEN mt.credited > 0 THEN ', credited ' || to_char(mt.credited, 'FM$999,999,990.00') ELSE '' END
                               || ', owing ' || to_char(mt.owing, 'FM$999,999,990.00') END
                     || CASE WHEN mt.overdue > 0 THEN ' (' || to_char(mt.overdue, 'FM$999,999,990.00') || ' overdue since '
                                                     || to_char(mt.oldest_overdue, 'Dy FMDD Mon') || ')' ELSE '' END
                     || CASE WHEN mt.drafts > 0 THEN '; ' || mt.drafts || ' draft ' || CASE WHEN mt.drafts = 1 THEN 'invoice' ELSE 'invoices' END
                                                     || ' of ' || to_char(mt.draft_total, 'FM$999,999,990.00') || ' not issued' ELSE '' END
                     || CASE WHEN coalesce(mt.nyi, 0) > 1 THEN '; ' || to_char(mt.nyi, 'FM$999,999,990.00') || ' of the job value not yet invoiced' ELSE '' END
                     || CASE WHEN mt.parties > 1 THEN '; ' || mt.parties || ' paying parties' ELSE '' END || '.',
             'job_value', jsonb_build_object('amount', mt.job_value, 'basis', mt.job_value_basis),
             'parties', coalesce((SELECT jsonb_agg(jsonb_build_object('party', m.party, 'xero_contact_id', m.xero_contact_id,
                          'invoiced', m.invoiced, 'paid', m.paid, 'credited', m.credited, 'owing', m.owing, 'overdue', m.overdue,
                          'oldest_overdue_due', m.oldest_overdue_due, 'drafts', m.drafts, 'draft_total', m.draft_total,
                          'invoices', m.invoices) ORDER BY m.owing DESC, m.party COLLATE "C", m.xero_contact_id COLLATE "C")
                          FROM mo m WHERE m.party IS NOT NULL), '[]'::jsonb),
             'not_yet_invoiced', CASE WHEN coalesce(mt.nyi, 0) > 1
                                      THEN jsonb_build_object('amount', mt.nyi, 'basis', 'job value (' || coalesce(mt.job_value_basis, 'unknown')
                                                              || ') minus issued customer invoices',
                                                              'cites', jsonb_build_array(jsonb_build_object('t', 'jobs', 'id', inp.job->>'id'))) END,
             'supplier_bills', coalesce(mt.bills, '[]'::jsonb))
           FROM mt, inp),
  'loops', coalesce((SELECT jsonb_agg(jsonb_build_object('key', l.key, 'source', l.source, 'rule', l.rule, 'about_key', l.about_key,
             'owner', l.owner, 'owner_name', l.owner_name, 'counterparty', l.counterparty, 'what', l.what, 'why', l.why, 'since', l.since,
             'due', l.due, 'age_days', l.age_days, 'status', l.status, 'closes_when', l.closes_when, 'blocks', l.blocks,
             'closing_evidence', l.closing_evidence, 'cites', l.cites, 'rank', l.rank) ORDER BY l.rank) FROM loops l), '[]'::jsonb),
  'checks', coalesce((SELECT jsonb_agg(jsonb_build_object('rule', c.rule, 'what', c.what, 'cites', c.cites)
                              ORDER BY c.opened_at, c.rule COLLATE "C", c.cites::text COLLATE "C", c.what COLLATE "C")
                      FROM checks c), '[]'::jsonb),
  -- each line names its record and that record's state (and a booking when it was made),
  -- so nothing downstream reads them from the words
  'timeline', coalesce((SELECT jsonb_agg(jsonb_build_object('at', t.at, 'date', t.perth_date, 'kind', t.kind, 'what', t.what,
                         'amount', t.amount, 'phase', t.phase, 'source_table', t.source_table, 'source_id', t.source_id,
                         'state', t.state, 'made_at', t.made_at,
                         'cites', jsonb_build_array(jsonb_build_object('t', t.source_table, 'id', t.source_id)))
                         ORDER BY t.at, t.kind COLLATE "C", t.source_id COLLATE "C", t.what COLLATE "C") FROM tlout t), '[]'::jsonb),
  'phase_notes', coalesce((SELECT jsonb_agg(jsonb_build_object('phase', v.phase, 'what', v.what,
                   'cites', (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(v.opened_by) c))
                   ORDER BY v.opened_at, v.item_key COLLATE "C") FROM vis v WHERE v.item_type = 'phase_note'
                   AND v.status NOT IN ('disputed', 'superseded', 'declined')), '[]'::jsonb),
  'agreements', coalesce((SELECT jsonb_agg(jsonb_build_object('key', v.item_key, 'what', v.what, 'modality', v.modality, 'since', v.opened_at,
                  'status', v.status, 'supersedes', v.supersedes_key,
                  'cites', (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(v.opened_by) c))
                  ORDER BY v.opened_at, v.item_key COLLATE "C") FROM vis v WHERE v.item_type = 'agreement'), '[]'::jsonb),
  'events', coalesce((SELECT jsonb_agg(jsonb_build_object('key', v.item_key, 'what', v.what, 'at', v.opened_at,
              'cites', (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(v.opened_by) c))
              ORDER BY v.opened_at, v.item_key COLLATE "C") FROM vis v WHERE v.item_type = 'event'
              AND v.status NOT IN ('disputed', 'superseded', 'declined')), '[]'::jsonb),
  'who', coalesce((SELECT jsonb_agg(jsonb_build_object('name', w.name, 'role', w.role, 'contact_ref', w.contact_ref, 'cites', w.cites)
                   ORDER BY w.ord, w.name COLLATE "C", w.role COLLATE "C") FROM who w), '[]'::jsonb),
  'last_exchange', (SELECT jsonb_build_object('customer_said', inp.rec->'contact'->'last_customer_message',
                     'we_told_customer', inp.rec->'contact'->'last_to_customer', 'internal', inp.rec->'contact'->'last_internal') FROM inp),
  'handling', (SELECT jsonb_build_object('customer_messages', coalesce((inp.rec->'contact'->>'customer_messages')::int, 0),
                'replies', coalesce((inp.rec->'contact'->>'replies')::int, 0),
                'median_reply_hours', (inp.rec->'contact'->>'median_reply_hours')::numeric,
                'unanswered', coalesce((inp.rec->'contact'->>'unanswered')::int, 0),
                'commitments', jsonb_build_object('kept', cm.kept, 'late', cm.late, 'open', cm.open_, 'overdue', cm.overdue))
               FROM inp, cm),
  'not_known', coalesce((SELECT jsonb_agg(jsonb_build_object('what', k.what, 'why', k.why) ORDER BY k.ord, k.what COLLATE "C") FROM nk k), '[]'::jsonb),
  'changes', (SELECT CASE WHEN inp.since IS NULL THEN NULL ELSE coalesce((SELECT jsonb_agg(x.o ORDER BY x.at, x.o::text COLLATE "C") FROM (
               SELECT t.at, jsonb_build_object('at', t.at, 'kind', t.kind, 'what', t.what,
                      'cites', jsonb_build_array(jsonb_build_object('t', t.source_table, 'id', t.source_id))) AS o
               FROM tlout t WHERE t.at > inp.since AND t.at <= inp.as_of
               UNION ALL
               SELECT l.since, jsonb_build_object('at', l.since, 'kind', 'loop_opened', 'what', l.what, 'cites', l.cites)
               FROM loops l WHERE l.since > inp.since
               UNION ALL
               SELECT (x->>'at')::timestamptz, jsonb_build_object('at', x->'at', 'kind', 'ledger_' || coalesce(x->>'to_status', 'change'),
                      'what', coalesce(x->>'reason', 'Ledger item ' || coalesce(x->>'item_key', '') || ' moved to ' || coalesce(x->>'to_status', '?')),
                      'cites', coalesce(x->'evidence', '[]'::jsonb))
               FROM jsonb_array_elements(coalesce(inp.led->'transitions', '[]'::jsonb)) x WHERE (x->>'at')::timestamptz > inp.since
              ) x), '[]'::jsonb) END FROM inp),
  'meta', (SELECT jsonb_build_object(
             'ledger', jsonb_build_object('status', led.status, 'generation_id', led.gen->'id', 'evidence_until', led.gen->'evidence_until',
                         'reader', led.gen->'reader', 'items', led.items, 'hidden_items', led.hidden, 'unread_rows', led.unread,
                         'needs_rebuild', led.hidden - led.hidden_locked > 0,
                         'stale', led.hidden - led.hidden_locked > 0 OR coalesce(led.unread, 0) > 0),
             'sources', coalesce(inp.meta->'sources', '{}'::jsonb), 'evidence_rows', coalesce((inp.meta->>'evidence_rows')::int, 0),
             'built_at', now())
           FROM inp, led)
 )
$fn$;
COMMENT ON FUNCTION public.context_job_story_assemble(jsonb, jsonb, jsonb, jsonb, timestamptz, timestamptz) IS
 'Job story (20261006014000), story fixes (20261006033000): every text sort and tiebreak that reaches the output is in C (byte) order (who, money parties, loops and their rank, cites, checks, timeline, phase notes, agreements, events, not known, changes, blockers), so the story reads the same on every server whatever the input order. Earlier: the pure assembler of job-story-v1. Reads no table: job header, record parts (timeline, loops, money, contact, facts), ledger (generation, items with citation re-check result, transitions, its reader''s unread rows) and meta in; the cited story out. meta.ledger = {status, generation_id, evidence_until, reader, items, hidden_items, unread_rows, needs_rebuild, stale}. Inlinable (no SET). Service role only.';

-- 4. The ledger read: items tie by item_key in C order.
CREATE OR REPLACE FUNCTION public.context_job_story_ledger(p_job_id uuid, p_generation_id uuid DEFAULT NULL, p_as_of timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH g AS (  -- the generation asked for, else the one live at p_as_of (the newest promoted by then)
  SELECT x.* FROM public.context_ledger_generations x
  WHERE x.job_id = p_job_id
    AND CASE WHEN p_generation_id IS NOT NULL THEN x.id = p_generation_id
             ELSE x.status IN ('live', 'retired') AND x.promoted_at <= p_as_of END
  ORDER BY x.promoted_at DESC NULLS LAST, x.created_at DESC LIMIT 1
 ),
 other AS (  -- with no generation to show, say whether one is being built or waits in shadow
  SELECT x.status FROM public.context_ledger_generations x
  WHERE x.job_id = p_job_id AND x.status IN ('building', 'shadow') AND NOT EXISTS (SELECT 1 FROM g)
  ORDER BY x.created_at DESC LIMIT 1
 ),
 evr AS MATERIALIZED (  -- the store's own evidence against the shown generation's evidence_until:
                       -- read when it landed by then (nothing is read when no generation is shown)
  SELECT r.src_id, r.copy_of, r.direction, (g.evidence_until IS NOT NULL AND r.landed_at <= g.evidence_until) AS was_read
  FROM g CROSS JOIN LATERAL public.context_ledger_evidence_rows(ARRAY[g.job_id], p_as_of) r
 ),
 unread AS (  -- what the shown generation's reader has not read; copies are listed by id
              -- but not counted as new messages
  SELECT e.src_id, e.copy_of FROM evr e WHERE NOT e.was_read
 ),
 it0 AS (  -- replay: items written by p_as_of, each with its status then
  SELECT i.*, coalesce((SELECT t.to_status FROM public.context_ledger_transitions t WHERE t.item_id = i.id AND t.at <= p_as_of
                         ORDER BY t.at DESC, t.id DESC LIMIT 1), i.status) AS status_then
  FROM public.context_ledger_items i JOIN g ON g.id = i.generation_id
  WHERE i.created_at <= p_as_of
 ),
 it AS (
  SELECT i.*,
   (SELECT jsonb_agg(jsonb_build_object('table', c->>'table', 'id', c->>'id', 'excerpt', c->>'excerpt',
            'at', coalesce(e.event_at, e.occurred_at),
            'ok', CASE WHEN c->>'table' <> 'business_events' THEN true
                       ELSE e.id IS NOT NULL AND e.job_id = p_job_id AND public.context_linked_status(e.attribution_status)
                            AND e.metadata->>'retracted_at' IS NULL AND coalesce(e.metadata->>'retracted', 'false') <> 'true' END,
            'customer', (e.metadata->'party_roles'->>'sender_role' = 'customer')))
    FROM jsonb_array_elements(i.opened_by || CASE WHEN i.closed_at <= p_as_of THEN coalesce(i.closed_by, '[]'::jsonb) ELSE '[]'::jsonb END) c
    LEFT JOIN public.business_events e ON c->>'table' = 'business_events'
     AND e.id = CASE WHEN c->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (c->>'id')::uuid END) AS cited
  FROM it0 i
 )
 SELECT jsonb_build_object(
  'status', coalesce((SELECT g.status FROM g), (SELECT other.status FROM other), 'none'),
  'generation', (SELECT jsonb_build_object('id', g.id, 'status', g.status, 'kind', g.kind, 'reader', g.reader, 'model', g.model,
                  'evidence_until', g.evidence_until, 'evidence_rows', g.evidence_rows, 'created_at', g.created_at,
                  'promoted_at', g.promoted_at) FROM g),
  'items', coalesce((SELECT jsonb_agg(jsonb_build_object('item_key', it.item_key, 'item_type', it.item_type, 'status', it.status_then,
              'from_role', it.from_role, 'from_name', it.from_name, 'to_role', it.to_role, 'to_name', it.to_name, 'what', it.what,
              'about_key', it.about_key, 'modality', it.modality, 'phase', it.phase, 'due_date', it.due_date, 'opened_at', it.opened_at,
              'opened_by', it.opened_by,
              'closed_at', CASE WHEN it.closed_at <= p_as_of AND it.status_then IN ('closed', 'declined', 'superseded') THEN it.closed_at END,
              'closed_by', CASE WHEN it.closed_at <= p_as_of AND it.status_then IN ('closed', 'declined', 'superseded') THEN it.closed_by END,
              'closes_on', it.closes_on,
              'supersedes_key', it.supersedes_key, 'blocks', it.blocks, 'needs_reply', it.needs_reply, 'written_by', it.written_by,
              'person_locked', it.person_locked, 'cited', it.cited,
              'cites_ok', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(it.cited, '[]'::jsonb)) c WHERE NOT (c->>'ok')::boolean))
              ORDER BY it.opened_at, it.item_key COLLATE "C") FROM it), '[]'::jsonb),
  'transitions', coalesce((SELECT jsonb_agg(jsonb_build_object('item_key', i.item_key, 'from_status', t.from_status,
                   'to_status', t.to_status, 'at', t.at, 'by', t.by, 'reason', t.reason, 'evidence', t.evidence) ORDER BY t.at, t.id)
                 FROM public.context_ledger_transitions t JOIN public.context_ledger_items i ON i.id = t.item_id
                 JOIN g ON g.id = t.generation_id WHERE t.at <= p_as_of), '[]'::jsonb),
  'unread_rows', CASE WHEN EXISTS (SELECT 1 FROM g) THEN (SELECT count(*)::integer FROM unread u WHERE u.copy_of IS NULL) END,
  'unread_ids', CASE WHEN EXISTS (SELECT 1 FROM g) THEN coalesce((SELECT jsonb_agg(u.src_id::text ORDER BY u.src_id) FROM unread u), '[]'::jsonb) END,
  -- the inbound rows it has read: the story says the reader judged a customer message only for these
  'read_ids', CASE WHEN EXISTS (SELECT 1 FROM g) THEN coalesce((SELECT jsonb_agg(e.src_id::text ORDER BY e.src_id) FROM evr e
                    WHERE e.was_read AND e.direction = 'inbound'), '[]'::jsonb) END
 )
$fn$;
COMMENT ON FUNCTION public.context_job_story_ledger(uuid, uuid, timestamptz) IS
 'Job story (20261006014000), story fixes (20261006033000): items tie on opened_at by item_key in C (byte) order. Earlier: the ledger generation the story shows (the one live at p_as_of, or the one asked for in any status) with the items written by p_as_of, each at its status then, and the transitions by then; every business_events citation is re-checked (still on this job, linked, not retracted) and the item carries cites_ok. unread_rows: the store''s evidence (context_ledger_evidence_rows as of p_as_of, copies not counted) that landed after the shown generation''s evidence_until, so the story says how far its own reader has read; unread_ids: those rows and their copies by id; read_ids: the inbound evidence rows it has read (landed by its evidence_until), so a customer message is called judged only when the reader read it; all three null when no generation is shown. With no generation to show, status says building or shadow when one exists, else none. Service role only.';

-- 5. The client story: one sort order, full tiebreaks.
CREATE OR REPLACE FUNCTION public.context_client_story(p_job_id uuid, p_as_of timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH me AS (
  SELECT jb.id, nullif(btrim(jb.ghl_contact_id), '') AS contact, lower(nullif(btrim(jb.client_email), '')) AS email
  FROM public.jobs jb WHERE jb.id = p_job_id
 ),
 ident AS (
  SELECT me.*, CASE WHEN me.contact IS NOT NULL THEN 'ghl_contact_id' WHEN me.email IS NOT NULL THEN 'client_email' END AS basis FROM me
 ),
 cj AS (  -- the client's jobs, newest first; the first 20 get a full story
  SELECT jb.id, jb.job_number, jb.type, jb.status::text AS status, jb.created_at,
         jb.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost') AS live,
         row_number() OVER (ORDER BY jb.created_at DESC, jb.id) AS n
  FROM ident i JOIN public.jobs jb
    ON (i.basis = 'ghl_contact_id' AND nullif(btrim(jb.ghl_contact_id), '') = i.contact)
    OR (i.basis = 'client_email' AND lower(nullif(btrim(jb.client_email), '')) = i.email)
  WHERE jb.created_at <= p_as_of
 ),
 st AS (SELECT cj.id, public.context_job_story(cj.id, p_as_of) AS s FROM cj WHERE cj.n <= 20),
 mon AS (SELECT m.* FROM public.context_job_record_money((SELECT array_agg(cj.id) FROM cj), p_as_of) m),
 lp AS (
  SELECT cj.job_number, l AS loop FROM st JOIN cj ON cj.id = st.id, jsonb_array_elements(st.s->'loops') l
 ),
 li AS (  -- visible ledger items across the shown stories' live generations
  SELECT cj.job_number, i.*
  FROM cj JOIN public.context_ledger_generations g ON g.job_id = cj.id AND g.status = 'live'
  JOIN public.context_ledger_items i ON i.generation_id = g.id
  WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(i.opened_by) c
                    LEFT JOIN public.business_events e
                      ON e.id = CASE WHEN c->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (c->>'id')::uuid END
                    WHERE c->>'table' = 'business_events'
                      AND (e.id IS NULL OR e.job_id IS DISTINCT FROM cj.id OR NOT public.context_linked_status(e.attribution_status)
                           OR e.metadata->>'retracted_at' IS NOT NULL))
 )
 SELECT jsonb_build_object(
  'version', 'client-story-v1',
  'as_of', p_as_of,
  'job_id', p_job_id,
  'identity', (SELECT jsonb_build_object('basis', i.basis, 'contact_ref', i.contact, 'email_known', i.email IS NOT NULL) FROM ident i),
  'jobs', coalesce((SELECT jsonb_agg(jsonb_build_object('job_id', cj.id, 'job_number', cj.job_number, 'type', cj.type, 'status', cj.status,
             'live', cj.live, 'created_at', cj.created_at, 'phase', st.s->'now'->'phase',
             'now', left(st.s->'now'->>'line', 200),
             'owing', (SELECT coalesce(sum(m.owing), 0) FROM mon m WHERE m.job_id = cj.id),
             'overdue', (SELECT coalesce(sum(m.overdue), 0) FROM mon m WHERE m.job_id = cj.id),
             'cites', jsonb_build_array(jsonb_build_object('t', 'jobs', 'id', cj.id))) ORDER BY cj.created_at DESC, cj.id)
           FROM cj LEFT JOIN st ON st.id = cj.id), '[]'::jsonb),
  'money', jsonb_build_object('owing', (SELECT coalesce(sum(m.owing), 0) FROM mon m), 'overdue', (SELECT coalesce(sum(m.overdue), 0) FROM mon m),
             'not_yet_invoiced', (SELECT coalesce(sum(x.nyi), 0) FROM (SELECT max(m.not_yet_invoiced) AS nyi FROM mon m GROUP BY m.job_id) x),
             'parties', coalesce((SELECT jsonb_agg(DISTINCT m.party COLLATE "C" ORDER BY m.party COLLATE "C") FROM mon m
                                  WHERE m.party IS NOT NULL), '[]'::jsonb),
             -- each paying party on its own: a neighbour's debt is never the client's
             'by_party', coalesce((SELECT jsonb_agg(jsonb_build_object('party', x.party, 'xero_contact_id', x.xero_contact_id,
                            'owing', x.owing, 'overdue', x.overdue, 'job_numbers', x.jobs)
                            ORDER BY x.owing DESC, x.party COLLATE "C", x.xero_contact_id COLLATE "C")
                          FROM (SELECT m.party, m.xero_contact_id, sum(m.owing) AS owing, sum(m.overdue) AS overdue,
                                       jsonb_agg(DISTINCT cj.job_number COLLATE "C" ORDER BY cj.job_number COLLATE "C") AS jobs
                                FROM mon m JOIN cj ON cj.id = m.job_id WHERE m.party IS NOT NULL
                                GROUP BY m.party, m.xero_contact_id) x), '[]'::jsonb)),
  'open_loops', coalesce((SELECT jsonb_agg(x.o ORDER BY x.r, x.s NULLS LAST, x.jn COLLATE "C", x.k COLLATE "C") FROM (
                   SELECT lp.loop || jsonb_build_object('job_number', lp.job_number) AS o, (lp.loop->>'rank')::int AS r,
                          (lp.loop->>'since')::timestamptz AS s, lp.job_number AS jn, lp.loop->>'key' AS k FROM lp
                   ORDER BY (lp.loop->>'rank')::int, (lp.loop->>'since')::timestamptz NULLS LAST, lp.job_number COLLATE "C",
                            (lp.loop->>'key') COLLATE "C" LIMIT 10) x), '[]'::jsonb),
  'past_issues', coalesce((SELECT jsonb_agg(jsonb_build_object('job_number', li.job_number, 'what', li.what, 'status', li.status,
                   'since', li.opened_at, 'closed_at', li.closed_at,
                   'cites', (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(li.opened_by) c))
                   ORDER BY li.opened_at, li.job_number COLLATE "C", li.item_key COLLATE "C") FROM li WHERE li.item_type = 'issue'), '[]'::jsonb),
  'preferences', coalesce((SELECT jsonb_agg(jsonb_build_object('job_number', li.job_number, 'type', li.item_type, 'what', li.what,
                   'about_key', li.about_key, 'status', li.status, 'since', li.opened_at,
                   'cites', (SELECT jsonb_agg(jsonb_build_object('t', c->>'table', 'id', c->>'id')) FROM jsonb_array_elements(li.opened_by) c))
                   ORDER BY li.opened_at, li.job_number COLLATE "C", li.item_key COLLATE "C")
                 FROM li WHERE li.item_type IN ('agreement', 'constraint') AND (li.about_key LIKE 'preference:%' OR li.about_key LIKE 'access:%')
                   AND li.status IN ('open', 'info')), '[]'::jsonb),
  'other_parties', coalesce((SELECT jsonb_agg(jsonb_build_object('job_number', cj.job_number, 'name', c.client_name, 'role', c.contact_type,
                   'contact_ref', c.ghl_contact_id, 'cites', jsonb_build_array(jsonb_build_object('t', 'job_contacts', 'id', c.id)))
                   ORDER BY cj.created_at DESC, cj.id, c.created_at, c.id)
                 FROM cj JOIN public.job_contacts c ON c.job_id = cj.id
                 WHERE c.removed_at IS NULL AND NOT coalesce(c.is_primary, false) AND coalesce(c.contact_type, '') <> 'primary'), '[]'::jsonb),
  'not_known', coalesce((SELECT jsonb_agg(x.o ORDER BY x.ord) FROM (
                   SELECT 1 AS ord, jsonb_build_object('what', 'This job has no CRM contact and no client email, so the client''s other jobs cannot be found.',
                          'why', 'Clients are matched by CRM contact or exact email, never by name.') AS o
                   FROM ident i WHERE i.basis IS NULL
                   UNION ALL
                   SELECT 2, jsonb_build_object('what', (SELECT count(*) FROM cj WHERE cj.n > 20) || ' older jobs are listed without a full story.',
                          'why', 'At most 20 stories are assembled in one read.')
                   WHERE (SELECT count(*) FROM cj WHERE cj.n > 20) > 0
                   UNION ALL
                   SELECT 3, jsonb_build_object('what', 'Matched by client email only; jobs under a different email or contact are not included.',
                          'why', 'This job has no CRM contact.')
                   FROM ident i WHERE i.basis = 'client_email'
                   UNION ALL
                   SELECT 5, jsonb_build_object('what', 'Owing and overdue add up every paying party on these jobs; money.by_party has each party on its own.',
                          'why', 'Shared work can have more than one payer.')
                   WHERE (SELECT count(DISTINCT coalesce(m.xero_contact_id, m.party)) FROM mon m WHERE m.party IS NOT NULL) > 1
                   UNION ALL
                   SELECT 4, jsonb_build_object('what', 'Past issues and preferences come only from jobs whose ledger is live.',
                          'why', 'The reader has not read every job yet.')
                   WHERE EXISTS (SELECT 1 FROM cj WHERE NOT EXISTS (SELECT 1 FROM public.context_ledger_generations g WHERE g.job_id = cj.id AND g.status = 'live'))
                  ) x), '[]'::jsonb)
 )
 WHERE EXISTS (SELECT 1 FROM me)
$fn$;
COMMENT ON FUNCTION public.context_client_story(uuid, timestamptz) IS
 'Job story (20261006014000), story fixes (20261006033000): parties, paying parties, job numbers, open loops (by rank, since as a time, job number, key), past issues, preferences and other parties sort in C (byte) order with full tiebreaks. Earlier: client-story-v1 for the client of one job: identity (CRM contact, else exact client email, never a name), every job of that client with phase, short now line and owing (full story for the newest 20), money across jobs (and by_party, each payer on its own), top 10 open loops, past issues and standing preferences or access constraints from live ledgers, other parties per job, and not_known. Service role only.';

-- 6. Access, as before: service role only (CREATE OR REPLACE keeps it; said again).
REVOKE ALL ON FUNCTION public.context_job_record_timeline(uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_record_loops(uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_story_assemble(jsonb, jsonb, jsonb, jsonb, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_job_story_ledger(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_client_story(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_job_record_timeline(uuid[], timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_record_loops(uuid[], timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_story_assemble(jsonb, jsonb, jsonb, jsonb, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_job_story_ledger(uuid, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_client_story(uuid, timestamptz) TO service_role;
