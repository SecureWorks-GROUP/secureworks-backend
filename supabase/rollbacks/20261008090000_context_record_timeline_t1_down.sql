-- Rollback of 20261008090000_context_record_timeline_t1: context_job_record_timeline goes back to the
-- story safety (20261006040000) body and comment, word for word (CREATE OR REPLACE keeps its grants;
-- said again). No row is written or deleted. Refuses while a later body has replaced this
-- migration's (roll that back first); a second run changes nothing.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE live text;
BEGIN
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_job_record_timeline(uuid[],timestamptz)');
 IF live IS NULL OR NOT live = ANY (ARRAY['5fc19734387ebc76337466f6710a1ac6', '0921f25dfb5a67ab04629d2977e9f0a6']) THEN
  RAISE EXCEPTION 'context_record_timeline_t1_down_refused: public.context_job_record_timeline(uuid[],timestamptz) md5 %; a later change replaced this body, roll that back first',
   coalesce(live, '<missing>');
 END IF;
END $guard$;

-- The story safety (20261006040000) body and comment, word for word.
CREATE OR REPLACE FUNCTION public.context_job_record_timeline(p_job_ids uuid[], p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, at timestamptz, perth_date date, time_basis text, kind text, what text, amount numeric,
 party text, placement text, source_table text, source_id text, state text, made_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH j AS (
  SELECT jb.id, jb.status::text AS status, jb.type::text AS type, jb.created_at, jb.quoted_at, jb.accepted_at,
         jb.approvals_at, jb.processing_at, jb.scheduled_at, jb.completed_at, jb.deposit_at, jb.deposit_amount, jb.job_number
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
         upper(coalesce(x.status, '')) AS st, upper(coalesce(x.invoice_type, 'ACCREC')) AS itype,
         -- a supplier bill whose lines name other jobs is shared: this job's lines are its share
         CASE WHEN upper(coalesce(x.invoice_type, 'ACCREC')) = 'ACCPAY'
              THEN public.context_job_record_bill_share(j.job_number, x.line_items, x.raw_json ->> 'LineAmountTypes') END AS share
  FROM public.xero_invoices x JOIN j ON j.id = x.job_id
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
               min(x.created_at) OVER (PARTITION BY x.job_id, x.event_type, x.obj, x.day) AS first_at,
               -- a folded clock-off line gives the day's hours: the sum of every stint's net
               -- hours, only when each stint folded into it carries them (else no hours)
               sum(CASE WHEN jsonb_typeof(x.d -> 'net_hours') = 'number' THEN (x.d ->> 'net_hours')::numeric END)
                OVER (PARTITION BY x.job_id, x.event_type, x.obj, x.day) AS net_sum,
               count(*) FILTER (WHERE jsonb_typeof(x.d -> 'net_hours') = 'number')
                OVER (PARTITION BY x.job_id, x.event_type, x.obj, x.day) AS net_n
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
                || CASE WHEN coalesce((i.share ->> 'shared')::boolean, false)
                        THEN ', shared with other jobs ' || coalesce('(this job''s lines ' || to_char((i.share ->> 'job_share')::numeric, 'FM$999,999,990.00') || ')',
                                                                     '(no line names this job)')
                        ELSE '' END
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
  -- (a change to a ghost or observer row, or one its writer tags as a ghost copy, is an
  -- observer's copy, never a crew booking: story safety, 20261006040000)
  SELECT je.job_id, je.created_at, 'observed',
         CASE WHEN coalesce(ga.mirror, false) OR coalesce(je.detail_json->>'source', '') LIKE 'ghost%' THEN 'booking_mirror'
              WHEN je.event_type = 'assignment_status_changed'
                   AND je.detail_json->>'new_status' IN ('started', 'in_progress', 'complete', 'completed') THEN 'attendance'
              ELSE 'booking_change' END,
         CASE WHEN coalesce(ga.mirror, false) OR coalesce(je.detail_json->>'source', '') LIKE 'ghost%'
              THEN 'Observer copy, not a crew booking: ' ELSE '' END
         || CASE je.event_type
           WHEN 'assignment_created' THEN 'Booking made for '
                || coalesce(to_char(public.context_job_record_date(je.detail_json->>'date'), 'Dy FMDD Mon YYYY'), 'a date not recorded')
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
  LEFT JOIN (SELECT a.id, coalesce(a.is_ghost, false) OR coalesce(a.role, '') = 'observer' AS mirror FROM public.job_assignments a) ga
    ON ga.id = CASE WHEN je.detail_json->>'assignment_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    THEN (je.detail_json->>'assignment_id')::uuid END
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
               || CASE WHEN e.n = 1 AND jsonb_typeof(e.d -> 'net_hours') = 'number'
                       THEN ' (' || rtrim(to_char((e.d ->> 'net_hours')::numeric, 'FM999990.99'), '.') || ' hours net)'
                       WHEN e.n > 1 AND e.net_n = e.n
                       THEN ' (' || rtrim(to_char(e.net_sum, 'FM999990.99'), '.') || ' hours net that day, all stints added)'
                       ELSE '' END
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
 'Job record (20261006011000), story fixes (20261006033000), story safety (20261006040000): a booking change on a ghost or observer row (is_ghost, or role observer), or one its writer tags as a ghost copy, is booking_mirror (an observer copy, never "Booking made"); a supplier bill whose lines name other jobs says it is shared and gives this job''s lines; first contact never comes from a text dated before the job''s lead window (context_job_record_messages). Earlier, story fixes: app events the ledger store lets close a matter (quote_sent, invoice.emailed, acceptance_invoice_sent, payment_link_sent, payment_received, payment_recorded, clock.clock_on, clock.clock_off, makesafe_report_submitted, roof_report_submitted) are lines citing job_events, one per event type, matter and Perth day (the newest cited, the count named; a folded clock-off gives the day''s net hours, every stint added, or none), each with state = its event_type, or not_delivered when it names a document whose every email bounced or failed and the customer never viewed or answered it; rows sort by time, then kind, source and words in C (byte) order. Earlier: one row per record milestone per job, oldest first (job created, first contact, site visit, quote version events with value, folded status changes, invoices, payments, credits, supplier bills, system emails, bookings, booking changes (never a crew-planning mark: a lock, a status mark, or a move to the same date), attendance, variations, purchase and work orders, rectification, make-safe, tasks, staff notes, documents). time_basis observed|date_only|stamp|scheduled. state: the cited record''s state (invoices draft, issued, paid, voided; documents generated, sent, viewed, accepted, declined, superseded; crew bookings scheduled, attended (started, completed, or status complete with neither recorded), cancelled (not standing: cancelled, deleted, draft, disputed, declined); else null); made_at: a crew booking''s created time. A status-only completion is timed at the end of its booked Perth day, or now while that is still ahead. Rows recorded after p_as_of are ignored; mutable rows are read as now. Service role only.';

REVOKE ALL ON FUNCTION public.context_job_record_timeline(uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_job_record_timeline(uuid[], timestamptz) TO service_role;
