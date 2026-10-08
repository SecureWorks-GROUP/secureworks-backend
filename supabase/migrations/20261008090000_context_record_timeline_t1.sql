-- Record timeline T1 (8 Oct 2026): every timeline line is a record milestone with its own date and words.
--
-- Why. The go-live grade of the 29 proof jobs (7 Oct, part A) failed T1 (the record timeline matches
-- its records: 0 missing, 0 extra, 0 wrong on every job; bar 29 of 29) on 7 jobs: 22 of 29. A re-check
-- on 8 Oct against a fresh read-only dump (needs.sql at 05:26:57Z) and grade_ref.py's reference found
-- the same causes, two more wrong values and one class of reference rows never shown. Each is fixed as
-- a general rule; none names a job.
--
--  1. A scope save was kind site_visit (SWF-261387, SWP-26991, SWF-261501; noted on 20 more proof
--     jobs): "Scope first saved in the scoping tool" on a day with no visit. It is kind scope_saved
--     now, its words unchanged. CRM appointments and recorded visit outcomes stay site_visit.
--  2. Job-row stage stamps written at the job's creation instant (SWF-26282: quoted, accepted and
--     complete all at the CRM sync instant of 22 Apr) read as milestones on that day. A stamp equal to
--     the creation instant is no stage line now; the job created line says the record was made
--     already marked in those stages, and that when it reached them is not recorded. A stamp written
--     later, even seconds later (a make-safe moved to processing 27 s after it was made), stays.
--  3. A crew row with no booked date, marked complete the moment it was made and never started or
--     clocked (the app writes one when a make-safe report is submitted, binding the report's trade to
--     the attendance: SWMS-261050's d2fac1c3, 29 Sep) read "Crew marked complete: install (no booked
--     date)", a second attendance that never happened. It is kind booking_record now ("Assignment
--     record with no booked date (install, complete), completed the moment it was made: not a crew
--     booking, and it does not date a visit"), with no state, no made_at and no attendance line. A
--     dated booking marked complete keeps its attendance line; a dateless booking that is not
--     complete stays a booking.
--  4. First contact was a text about another site (SWF-261209: our 3 Jul and 30 Jul texts about the
--     customer's share of a shared fence on another job, where they were a neighbour party, six and
--     two weeks before this job was made). A message from before the job was made, while the same
--     person (the job's CRM contact, client email, or its primary party's CRM contact, email or
--     phone) was a party other than the client on another job still open then, is never the job's
--     first contact, and the line says how many such earlier messages it left out ("2 earlier
--     messages with them are left out: they were sent while this person was a party on another open
--     job"). Never by name; never when the person was that job's own client (a repeat client), or
--     after it closed.
--  5. Repair stage changes were missing (SWR-261364: 6 repair_stage_changed events, scoping to on
--     site to complete and back). Each is a repair_stage line now: "Repair stage set to on site
--     (from scheduled)"; a change to the same stage is none. Their own kind, so the story's status
--     times (since when, work done since) do not move.
--  6. A deleted invoice's state was voided (its words said deleted: SWF-261387, SWMS-261050,
--     SWMS-261415, SWP-26183, SWP-26373). Its state is deleted now; a voided one stays voided. No
--     reader closes on either (the store and the reader close on issued or paid only).
--  7. A fold of status changes within minutes did not say where it started (SWF-26545, SWF-261305:
--     "2 times within minutes: awaiting supplier -> processing", the first change's from missing).
--     The path starts with the first change's from now; ties are broken in C order.
--  8. A clock-off submitted twice 0.6 s apart for one booking with the same hours read "22.54 hours
--     net that day, all stints added" (SWP-26183, 24 Sep; 11.27 hours). A clock-off sent again
--     within a minute for the same booking with the same net hours is one stint: counted in
--     "recorded 2 times that day", never added to the hours.
--  9. The reference lists every assignment job event, and assignment_updated was never read (the
--     5 Oct ghost correction wrote 48 on 43 jobs, 9 of them on 8 proof jobs; the 7 Oct graders let
--     them pass as observer copies). Each is a line now, "Booking record updated (booked ...)", and an
--     observer copy's is a booking_mirror line like every other change on a ghost row (the story's
--     own timeline and the reader never show booking_mirror lines).
--
-- Read only on production (8 Oct 2026; every query BEGIN READ ONLY ... ROLLBACK with a 30 s statement
-- timeout, the new body inlined as a query, never created there; samples, never every job):
--   * The 29 proof jobs at the dump instant (05:26:57Z): the live timeline equals the dump's on every
--     job (no drift). Before: 15 reference rows missing (9 assignment_updated on 8 jobs, 6 repair
--     stage changes), 5 wrong states (deleted as voided), 23 scope saves as site visits, 3 stamps at
--     the sync instant, 1 summed clock-off, 1 first contact about another site, 1 dateless record
--     read as attendance, 2 folds without their start. After: 0 missing, 0 wrong, 0 flagged on all
--     29; nothing else changed on any proof job.
--   * 730 live jobs (status not cancelled, draft, archived, complete, completed or lost; not
--     archived). A sample of 30 (ordered by md5 of id and a fixed salt), old body against the new:
--     20 jobs changed, only by these rules: 10 scope saves (10 jobs), 4 stamps written at creation
--     (4 jobs; the stamp line goes, the job created line says so), 1 dateless report-binding row
--     (1 job: its attendance line goes, its booking line is booking_record), 6 deleted invoices
--     (4 jobs), 3 repair stage lines (1 job), 1 assignment_updated line (1 job); no other line moved.
--   * The rules' own rows, read where they sit (small selective reads, no story replay): 368 live
--     jobs have a scope save (368 lines change kind; none of them reads phase "scope" from it: each
--     has a status at quoted or later); 153 deleted invoices on 114 live jobs; 34 dateless
--     report-binding rows on 33 live jobs (48 in all, every one made complete within a minute of
--     being made, never started or clocked, bound to a make-safe report's cycle); 53 repair stage lines on 16
--     live jobs; 40 assignment_updated lines on 37 live jobs; 1 live job with a clock-off sent twice;
--     first contact changes on 3 of the 6 live jobs whose customer is a party on another job (2, 12
--     and 21 earlier messages left out, each said in the line). Stamps written at creation: 4 of the
--     30 sampled, about 100 live jobs.
--   * Hand-checked against their rows: a booking_record (status complete, no booked date, completed
--     0.1 s before it was made, bound to the report with the same id), a repair stage line (wo_in to
--     scoping), an observer copy's assignment_updated (ghost correction, booked 25 Sep), a scope save
--     (the scoping tool), a job made already accepted (accepted_at equal to created_at, no status
--     row within the hour), a deleted invoice (DELETED in Xero), and the three first contacts.
--
-- Replaced body (guarded on its live production md5, the 20261006040000 body; origin/main adc05bea):
--   context_job_record_timeline. Added: nothing. Not changed: every other record, story, ledger and
--   scorecard function, and every row. Signature, volatility, owner and grants stay; the comment
--   keeps its slice name first.
-- Readers: the story reads the timeline whole (context_job_story). The assembler's scoped_at reads
--   kind site_visit (its phase "scope"), so a job whose only scoping record is a scope save no longer
--   reads as scoping from the timeline (0 live jobs on 8 Oct; the assembler is another slice's). Its
--   status times read kind status and rectification (observed), so repair_stage lines move neither.
--   The Jarvis ledger reader reads the story's timeline lines by kind and state: a booking_record
--   line never stands as a booking, never closes and gives no visit; a deleted invoice never closes,
--   as a voided one never did; booking_mirror lines are not in the story's timeline.
-- Query shape: per call one more read of job_contacts (168 rows on 8 Oct, scanned once) for the
--   first contact rule; per clock-off one indexed look-up of the job's clock-offs a minute before it.
-- Rollback: supabase/rollbacks/20261008090000_context_record_timeline_t1_down.sql (the
--   20261006040000 body and comment word for word; no row touched).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Pre-image guard. The timeline must be the story safety (20261006040000) body production runs
-- (md5 of prosrc read from production read-only on 8 Oct 2026; origin/main adc05bea leaves the same)
-- or this migration's own (a re-apply is a no-op); anything else is someone else's change and is
-- refused, never overwritten. Every function, table and column the new body reads must exist.
DO $guard$
DECLARE problems text[] := '{}'; live text; f text; t text;
BEGIN
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_job_record_timeline(uuid[],timestamptz)');
 IF live IS NULL OR NOT live = ANY (ARRAY['0921f25dfb5a67ab04629d2977e9f0a6', '5fc19734387ebc76337466f6710a1ac6']) THEN
  problems := problems || format('public.context_job_record_timeline(uuid[],timestamptz) md5 %s', coalesce(live, '<missing>'));
 END IF;
 FOREACH f IN ARRAY ARRAY['public.context_job_record_messages(uuid[],timestamptz)', 'public.context_job_record_bill_share(text,jsonb,text)',
   'public.context_job_record_date(text)', 'public.job_quote_values(uuid)', 'public.context_email_key(text)', 'public.context_phone_key(text)'] LOOP
  IF to_regprocedure(f) IS NULL THEN problems := problems || format('%s missing', f); END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['jobs.ghl_contact_id', 'jobs.client_email', 'jobs.created_at', 'jobs.updated_at', 'jobs.status', 'jobs.archived',
   'job_contacts.job_id', 'job_contacts.ghl_contact_id', 'job_contacts.client_email', 'job_contacts.client_phone', 'job_contacts.phone_last9',
   'job_contacts.contact_type', 'job_contacts.is_primary', 'job_contacts.removed_at', 'job_assignments.scheduled_date',
   'job_assignments.completed_at', 'job_assignments.started_at', 'job_assignments.clocked_on_at', 'job_assignments.created_at',
   'job_events.detail_json', 'job_events.event_type', 'job_events.created_at'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.' || split_part(t, '.', 1))
                 AND a.attname = split_part(t, '.', 2) AND NOT a.attisdropped) THEN
   problems := problems || format('public.%s missing', t);
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_record_timeline_t1_preimage_mismatch: %; read the live definition before replacing it',
   array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The record timeline, with the T1 rules (each marked "record timeline T1" in the body).
CREATE OR REPLACE FUNCTION public.context_job_record_timeline(p_job_ids uuid[], p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, at timestamptz, perth_date date, time_basis text, kind text, what text, amount numeric,
 party text, placement text, source_table text, source_id text, state text, made_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 WITH j AS (
  SELECT jb.id, jb.status::text AS status, jb.type::text AS type, jb.created_at, jb.quoted_at, jb.accepted_at,
         jb.approvals_at, jb.processing_at, jb.scheduled_at, jb.completed_at, jb.deposit_at, jb.deposit_amount, jb.job_number,
         nullif(btrim(jb.ghl_contact_id), '') AS gc, public.context_email_key(jb.client_email) AS em
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
  WINDOW w AS (PARTITION BY s.job_id ORDER BY s.at, s.sid COLLATE "C")
 ),
 st2 AS (SELECT s.*, sum(s.brk) OVER (PARTITION BY s.job_id ORDER BY s.at, s.sid COLLATE "C") AS grp FROM st1 s),
 st3 AS (SELECT s.*, lag(s.to_s) OVER (PARTITION BY s.job_id, s.grp ORDER BY s.at, s.sid COLLATE "C") AS prev_to FROM st2 s),
 stg AS (
  SELECT s.job_id, s.grp, count(*) AS n, min(s.at) AS first_at, max(s.at) AS last_at,
         (array_agg(s.from_s ORDER BY s.at, s.sid COLLATE "C") FILTER (WHERE s.from_s IS NOT NULL))[1] AS from_s,
         -- (record timeline T1, 20261008090000) where a fold of several changes started: the first
         -- change's own from, so every step of the path shows its from and its to
         (array_agg(s.from_s ORDER BY s.at, s.sid COLLATE "C"))[1] AS start_from,
         (array_agg(s.to_s ORDER BY s.at, s.sid COLLATE "C"))[1] AS start_to,
         string_agg(replace(s.to_s, '_', ' '), ' -> ' ORDER BY s.at, s.sid COLLATE "C") FILTER (WHERE s.prev_to IS DISTINCT FROM s.to_s) AS path,
         count(*) FILTER (WHERE s.prev_to IS DISTINCT FROM s.to_s) AS steps,
         (array_agg(s.to_s ORDER BY s.at DESC, s.sid COLLATE "C" DESC))[1] AS final_to,
         (array_agg(s.tbl ORDER BY s.at DESC, s.sid COLLATE "C" DESC))[1] AS tbl,
         (array_agg(s.sid ORDER BY s.at DESC, s.sid COLLATE "C" DESC))[1] AS sid
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
  SELECT a.*, coalesce(a.is_ghost, false) OR coalesce(a.role, '') = 'observer' AS mirror,
         -- (record timeline T1, 20261008090000) a crew row with no booked date that was marked
         -- complete the moment it was made (within a minute) and never started or clocked: the app
         -- writes one when a make-safe report is submitted (it binds the report's trade to the
         -- attendance). It is no crew booking and its time is the report's, never a visit's: no
         -- attendance line, no state, no made_at
         (a.scheduled_date IS NULL AND a.completed_at IS NOT NULL AND a.started_at IS NULL AND a.clocked_on_at IS NULL
          AND abs(extract(epoch FROM a.completed_at - a.created_at)) < 60
          AND NOT (coalesce(a.is_ghost, false) OR coalesce(a.role, '') = 'observer')) AS rec_only
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
         -- (record timeline T1, 20261008090000) a clock-off sent again within a minute for the same
         -- booking with the same net hours is the same stint submitted twice (SWP-26183's 24 Sep pair,
         -- 0.6 s apart): it is counted, never added to the day's hours
         (je.event_type = 'clock.clock_off' AND EXISTS (
            SELECT 1 FROM public.job_events p
            WHERE p.job_id = je.job_id AND p.event_type = 'clock.clock_off' AND p.created_at <= p_as_of
              AND (p.created_at, p.id) < (je.created_at, je.id) AND p.created_at >= je.created_at - interval '1 minute'
              AND p.detail_json ->> 'assignment_id' IS NOT DISTINCT FROM je.detail_json ->> 'assignment_id'
              AND p.detail_json -> 'net_hours' IS NOT DISTINCT FROM je.detail_json -> 'net_hours')) AS dup,
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
               -- hours, only when each stint folded into it carries them (else no hours); a
               -- stint submitted twice is one stint (dup)
               sum(CASE WHEN NOT x.dup AND jsonb_typeof(x.d -> 'net_hours') = 'number' THEN (x.d ->> 'net_hours')::numeric END)
                OVER (PARTITION BY x.job_id, x.event_type, x.obj, x.day) AS net_sum,
               count(*) FILTER (WHERE NOT x.dup AND jsonb_typeof(x.d -> 'net_hours') = 'number')
                OVER (PARTITION BY x.job_id, x.event_type, x.obj, x.day) AS net_n,
               count(*) FILTER (WHERE NOT x.dup) OVER (PARTITION BY x.job_id, x.event_type, x.obj, x.day) AS stints
        FROM ae0 x
        ORDER BY x.job_id, x.event_type, x.obj, x.day, x.created_at DESC, x.id DESC) g
 ),
 -- (record timeline T1, 20261008090000) stage stamps on the job row, unless a status row
 -- already shows that stage within an hour; a stamp written with the row itself (the very
 -- instant the job was created: a CRM sync or import made the job already in that stage)
 -- says only that, never when the job reached the stage
 stp AS (
  SELECT j.id AS job_id, s.o, s.stage, s.at, s.at = j.created_at AS at_creation
  FROM j CROSS JOIN LATERAL (VALUES (1, 'quoted', j.quoted_at), (2, 'accepted', j.accepted_at), (3, 'deposit', j.deposit_at),
       (4, 'approvals', j.approvals_at), (5, 'processing', j.processing_at), (6, 'scheduled', j.scheduled_at),
       (7, 'complete', j.completed_at)) s(o, stage, at)
  WHERE s.at IS NOT NULL AND s.at <= p_as_of
    AND NOT EXISTS (SELECT 1 FROM st0 x WHERE x.job_id = j.id
                    AND (x.to_s = s.stage OR (s.stage = 'complete' AND x.to_s IN ('completed', 'complete')))
                    AND abs(extract(epoch FROM x.at - s.at)) < 3600)
 ),
 -- (record timeline T1, 20261008090000) the person who is this job's customer, by CRM contact,
 -- client email (never one of ours) and phone: the job row's and its primary party's
 who AS (
  SELECT j.id AS job_id, 'gc'::text AS k, j.gc AS v FROM j WHERE j.gc IS NOT NULL
  UNION
  SELECT j.id, 'em', j.em FROM j WHERE j.em IS NOT NULL
  UNION
  SELECT c.job_id, x.k, x.v
  FROM public.job_contacts c
  CROSS JOIN LATERAL (VALUES ('gc', nullif(btrim(c.ghl_contact_id), '')), ('em', public.context_email_key(c.client_email)),
                             ('ph', public.context_phone_key(c.client_phone))) x(k, v)
  WHERE c.job_id = ANY (p_job_ids) AND c.removed_at IS NULL
    AND (coalesce(c.is_primary, false) OR coalesce(c.contact_type, 'primary') = 'primary') AND x.v IS NOT NULL
 ),
 -- ... and every other job where that person is a party other than its client (a neighbour,
 -- strata or other payer; never the person's own job as its client): from when that job was
 -- made until it closed (cancelled, lost, archived or complete: its last change) or the party
 -- was removed
 pty AS (
  SELECT DISTINCT w.job_id, o.created_at AS made_at,
         least(CASE WHEN o.status::text IN ('cancelled', 'lost', 'archived', 'complete', 'completed') OR coalesce(o.archived, false)
                    THEN o.updated_at END, oc.removed_at) AS until_at
  FROM who w
  JOIN public.job_contacts oc ON oc.job_id <> w.job_id
   AND NOT (coalesce(oc.is_primary, false) OR coalesce(oc.contact_type, 'primary') = 'primary')
   AND CASE w.k WHEN 'gc' THEN nullif(btrim(oc.ghl_contact_id), '') = w.v
                WHEN 'em' THEN public.context_email_key(oc.client_email) = w.v
                ELSE oc.phone_last9 = w.v END
  JOIN public.jobs o ON o.id = oc.job_id
  WHERE NOT EXISTS (SELECT 1 FROM who w2 WHERE w2.job_id = w.job_id
                    AND ((w2.k = 'gc' AND nullif(btrim(o.ghl_contact_id), '') = w2.v)
                         OR (w2.k = 'em' AND public.context_email_key(o.client_email) = w2.v)))
 ),
 -- (record timeline T1, 20261008090000) the customer's messages, each marked when it is another
 -- job's: sent before this job was made, while the same person was a party other than the client
 -- (a neighbour or other payer) on another job still open then (SWF-261209: texts about the
 -- person's share of a shared fence on another job, weeks before this job)
 fcm AS (
  SELECT c.job_id, c.at, c.channel, c.event_type, c.direction, c.placement, c.source_table, c.source_id,
         (c.at < j.created_at AND EXISTS (SELECT 1 FROM pty o WHERE o.job_id = c.job_id AND o.made_at <= c.at
                                         AND (o.until_at IS NULL OR o.until_at > c.at))) AS other_job
  FROM msg c JOIN j ON j.id = c.job_id
  WHERE c.customer_side
 ),
 m AS (
  -- job created
  -- (record timeline T1, 20261008090000) a row made already in a stage says so here, with no
  -- date for the stage: when the job reached it is not recorded
  SELECT j.id AS job_id, j.created_at AS at, 'observed'::text AS time_basis, 'job_created'::text AS kind,
         'Job created (' || coalesce(j.type, 'type not set') || ')'
           || coalesce(', its record already marked ' || cs.words || ' when it was made (when it reached '
                       || CASE WHEN cs.n = 1 THEN 'that stage' ELSE 'those stages' END || ' is not recorded)', '') AS what,
         NULL::numeric AS amount, NULL::text AS party,
         'on_job'::text AS placement, 'jobs'::text AS source_table, j.id::text AS source_id
  FROM j
  LEFT JOIN LATERAL (
   SELECT count(*)::integer AS n,
          CASE WHEN count(*) = 1 THEN min(x.stage)
               ELSE array_to_string((array_agg(x.stage ORDER BY x.o))[1:count(*)::integer - 1], ', ')
                    || ' and ' || (array_agg(x.stage ORDER BY x.o))[count(*)::integer] END AS words
   FROM stp x WHERE x.job_id = j.id AND x.at_creation) cs ON true
  WHERE j.created_at <= p_as_of
  -- stage stamps on the job row, unless a status row already shows that stage (stp), and
  -- never one written at the job's creation instant
  UNION ALL
  SELECT s.job_id, s.at, 'stamp', 'status',
         'Job record stamp: entered ' || replace(s.stage, '_', ' ') || ' (the job row keeps only the last time it entered this stage)',
         CASE WHEN s.stage = 'deposit' THEN j.deposit_amount END, NULL, 'on_job', 'jobs', s.job_id::text
  FROM stp s JOIN j ON j.id = s.job_id
  WHERE NOT s.at_creation
  -- status changes
  UNION ALL
  SELECT g.job_id, g.last_at, 'observed',
         CASE WHEN g.final_to = 'rectification' THEN 'rectification' ELSE 'status' END,
         CASE WHEN g.steps <= 1 THEN 'Status set to ' || replace(g.final_to, '_', ' ')
                   || coalesce(' (from ' || replace(g.from_s, '_', ' ') || ')', '')
              ELSE 'Status changed ' || g.steps || ' times within minutes: '
                   || CASE WHEN g.start_from IS NOT NULL AND g.start_from IS DISTINCT FROM g.start_to
                           THEN replace(g.start_from, '_', ' ') || ' -> ' ELSE '' END || g.path
                   || '; it ended at ' || replace(g.final_to, '_', ' ') END,
         NULL, NULL, 'on_job', g.tbl, g.sid
  FROM stg g
  -- (record timeline T1, 20261008090000) repair stage changes (the stages of repair and
  -- make-safe work: work order in, scoping, quoted, approved, materials, scheduled, on site,
  -- complete), one line each with its from and to; a change to the same stage is none
  UNION ALL
  SELECT je.job_id, je.created_at, 'observed', 'repair_stage',
         'Repair stage set to ' || CASE WHEN btrim(je.detail_json ->> 'to_stage') = 'wo_in' THEN 'work order in'
                                        ELSE replace(btrim(je.detail_json ->> 'to_stage'), '_', ' ') END
           || coalesce(' (from ' || CASE WHEN btrim(je.detail_json ->> 'from_stage') = 'wo_in' THEN 'work order in'
                                         ELSE replace(nullif(btrim(je.detail_json ->> 'from_stage'), ''), '_', ' ') END || ')', ''),
         NULL, NULL, 'on_job', 'job_events', je.id::text
  FROM public.job_events je
  WHERE je.job_id = ANY (p_job_ids) AND je.event_type = 'repair_stage_changed' AND je.created_at <= p_as_of
    AND nullif(btrim(je.detail_json ->> 'to_stage'), '') IS NOT NULL
    AND nullif(btrim(je.detail_json ->> 'from_stage'), '') IS DISTINCT FROM btrim(je.detail_json ->> 'to_stage')
  -- first message with the customer (texts, emails, calls, legacy mail)
  UNION ALL
  SELECT * FROM (
   SELECT DISTINCT ON (c.job_id) c.job_id, c.at, 'observed', 'first_contact',
          'First message with the customer on record (' || coalesce(c.channel, c.event_type) || ', '
            || CASE WHEN c.direction = 'inbound' THEN 'from the customer' ELSE 'from us' END
            || CASE WHEN c.placement = 'not_placed' THEN ', not placed on any job' ELSE '' END || ')'
            -- (record timeline T1, 20261008090000) another job's messages (fcm) are never this job's
            -- first contact; the line says how many earlier ones were left out, and why
            || coalesce('; ' || CASE WHEN x.n = 1 THEN '1 earlier message with them is left out: it was'
                                     ELSE x.n || ' earlier messages with them are left out: they were' END
                        || ' sent while this person was a party on another open job', ''),
          NULL::numeric, NULL::text, c.placement, c.source_table, c.source_id
   FROM fcm c
   LEFT JOIN (SELECT f.job_id, count(*) AS n FROM fcm f WHERE f.other_job GROUP BY f.job_id) x ON x.job_id = c.job_id
   WHERE NOT c.other_job
   ORDER BY c.job_id, c.at, c.source_id COLLATE "C") fc
  -- site visits: CRM appointments and recorded visit outcomes (the scope first saved is its own
  -- kind, scope_saved, below: a save in the scoping tool is no visit, record timeline T1)
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
   SELECT DISTINCT ON (je.job_id) je.job_id, je.created_at, 'observed', 'scope_saved',
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
         CASE WHEN a.mirror THEN 'booking_mirror' WHEN a.rec_only THEN 'booking_record' ELSE 'booking' END,
         CASE WHEN a.rec_only
              THEN 'Assignment record with no booked date (' || replace(coalesce(a.assignment_type, 'visit'), '_', ' ')
                   || coalesce(', ' || nullif(btrim(a.crew_name), ''), '') || ', ' || coalesce(a.status, 'status not set')
                   || '), completed the moment it was made: not a crew booking, and it does not date a visit'
              ELSE
         CASE WHEN a.mirror THEN 'Observer copy of a booking (not a crew booking): ' ELSE 'Booking: ' END
           || replace(coalesce(a.assignment_type, 'visit'), '_', ' ') || ' '
           || coalesce(to_char(a.scheduled_date, 'Dy FMDD Mon YYYY'), 'with no date set (shown when it was made)')
           || coalesce(' to ' || to_char(nullif(a.scheduled_end, a.scheduled_date), 'Dy FMDD Mon'), '')
           || coalesce(', ' || nullif(btrim(a.crew_name), ''), '') || ', ' || coalesce(a.status, 'status not set') END,
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
  WHERE NOT a.mirror AND NOT a.rec_only
    AND (lower(coalesce(a.status, '')) IN ('complete', 'completed', 'in_progress') OR a.completed_at IS NOT NULL OR a.started_at IS NOT NULL)
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
           -- (record timeline T1, 20261008090000) a booking row's details changed (the 5 Oct 2026
           -- ghost correction is the only writer so far: an observer copy's crew), with its booked day
           WHEN 'assignment_updated' THEN 'Booking record updated'
                || coalesce(' (booked ' || to_char(public.context_job_record_date(je.detail_json->>'date'), 'Dy FMDD Mon YYYY') || ')', '')
           ELSE replace(je.event_type, '_', ' ') END,
         NULL, NULL, 'on_job', 'job_events', je.id::text
  FROM public.job_events je
  LEFT JOIN (SELECT a.id, coalesce(a.is_ghost, false) OR coalesce(a.role, '') = 'observer' AS mirror FROM public.job_assignments a) ga
    ON ga.id = CASE WHEN je.detail_json->>'assignment_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    THEN (je.detail_json->>'assignment_id')::uuid END
  WHERE je.job_id = ANY (p_job_ids) AND je.created_at <= p_as_of
    AND je.event_type IN ('assignment_created', 'assignment_deleted', 'assignment_removed', 'assignment_rescheduled',
                          'assignment_confirmed', 'assignment_status_changed', 'assignment_acknowledged', 'assignment_updated')
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
               || CASE WHEN e.stints = 1 AND e.net_n = 1
                       THEN ' (' || rtrim(to_char(e.net_sum, 'FM999990.99'), '.') || ' hours net)'
                       WHEN e.stints > 1 AND e.net_n = e.stints
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
        -- invoices draft | issued | paid | voided | deleted (record timeline T1: a deleted invoice
        -- is deleted, never voided); documents generated | sent |
        -- not_delivered (every email of it bounced or failed, never viewed or answered) |
        -- viewed | accepted | declined | superseded (as of p_as_of); system emails sent |
        -- delivered | accepted (with a sent time) | not_sent | bounced | failed | queued;
        -- crew bookings scheduled | attended (started, completed, or a status-only
        -- completion) | cancelled (not standing), an assignment record (booking_record) none;
        -- app events the ledger store lets close
        -- a matter: their event_type (quote_sent, invoice.emailed, payment_received,
        -- clock.clock_off ...), or not_delivered when the event names a document whose
        -- every email bounced or failed (never viewed or answered); every other row
        -- null. Crew planning's confirmation is never read.
        CASE m.source_table
         WHEN 'xero_invoices' THEN (SELECT CASE WHEN i.st = 'DRAFT' THEN 'draft' WHEN i.st = 'PAID' THEN 'paid'
                                               WHEN i.st = 'VOIDED' THEN 'voided' WHEN i.st = 'DELETED' THEN 'deleted'
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
         WHEN 'job_assignments' THEN (SELECT CASE WHEN a.mirror OR a.rec_only THEN NULL
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
        CASE WHEN m.source_table = 'job_assignments' THEN (SELECT a.created_at FROM asg a WHERE a.id::text = m.source_id AND NOT a.mirror AND NOT a.rec_only) END
         AS made_at
 FROM m WHERE m.at IS NOT NULL
 ORDER BY m.job_id, m.at, m.kind COLLATE "C", m.source_id COLLATE "C", m.what COLLATE "C"
$fn$;
COMMENT ON FUNCTION public.context_job_record_timeline(uuid[], timestamptz) IS
 'Job record (20261006011000), story fixes (20261006033000), story safety (20261006040000): (record timeline T1, 20261008090000) every line is a record milestone with its own date and words (proof-set test T1): a scope saved in the scoping tool is kind scope_saved, never a site visit; a job-row stage stamp written at the job''s creation instant (a CRM sync or import made the row already in that stage) is no stage line: the job created line says the record was made already marked so, with no date for the stage; a crew row with no booked date marked complete the moment it was made and never started or clocked (the app writes one when a make-safe report is submitted) is kind booking_record, with no state, no made_at and no attendance line: never a crew booking, and it does not date a visit; a booking row''s details changed (assignment_updated) is a booking change, an observer copy''s a booking_mirror; first contact is never a message from before the job was made while the same person (the job''s CRM contact, client email or primary party''s CRM contact, email or phone) was a party other than the client on another job still open then, and the line says how many such earlier messages it left out; each repair stage change (repair_stage_changed) is a repair_stage line with its from and to, a change to the same stage none; a deleted invoice''s state is deleted (a voided one voided); a fold of several status changes starts its path with the first change''s from, ties broken in C order; a clock-off sent again within a minute for the same booking with the same net hours is one stint, counted but never added to the day''s hours. Earlier, story safety: a booking change on a ghost or observer row (is_ghost, or role observer), or one its writer tags as a ghost copy, is booking_mirror (an observer copy, never "Booking made"); a supplier bill whose lines name other jobs says it is shared and gives this job''s lines; first contact never comes from a text dated before the job''s lead window (context_job_record_messages). Earlier, story fixes: app events the ledger store lets close a matter (quote_sent, invoice.emailed, acceptance_invoice_sent, payment_link_sent, payment_received, payment_recorded, clock.clock_on, clock.clock_off, makesafe_report_submitted, roof_report_submitted) are lines citing job_events, one per event type, matter and Perth day (the newest cited, the count named; a folded clock-off gives the day''s net hours, every stint added, or none), each with state = its event_type, or not_delivered when it names a document whose every email bounced or failed and the customer never viewed or answered it; rows sort by time, then kind, source and words in C (byte) order. Earlier: one row per record milestone per job, oldest first (job created, first contact, site visit, quote version events with value, folded status changes, invoices, payments, credits, supplier bills, system emails, bookings, booking changes (never a crew-planning mark: a lock, a status mark, or a move to the same date), attendance, variations, purchase and work orders, rectification, make-safe, tasks, staff notes, documents). time_basis observed|date_only|stamp|scheduled. state: the cited record''s state (invoices draft, issued, paid, voided; documents generated, sent, viewed, accepted, declined, superseded; crew bookings scheduled, attended (started, completed, or status complete with neither recorded), cancelled (not standing: cancelled, deleted, draft, disputed, declined); else null); made_at: a crew booking''s created time. A status-only completion is timed at the end of its booked Perth day, or now while that is still ahead. Rows recorded after p_as_of are ignored; mutable rows are read as now. Service role only.';

-- 2. Access: service role only (CREATE OR REPLACE keeps the grants; said again).
REVOKE ALL ON FUNCTION public.context_job_record_timeline(uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_job_record_timeline(uuid[], timestamptz) TO service_role;
