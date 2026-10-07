-- Jev's five watch points: five more decision points in the Jev shadow log,
-- each off until its own switch is on, and the agreement read for them (7 Oct
-- 2026).
--
-- Why. Since 7 Oct 10:11 Perth the context worker asks Jev (TypeSafe AI's
-- decision model, jev-1.13.0) in watch-only shadow at three points (placement,
-- the ledger update gate, the ledger's reply-owed candidates) and logs its
-- answer beside today's in context_jev_decisions (20261006080000). The owner
-- asked for five more watch-only points. The worker (secureworks-jarvis
-- src/automation/jev-points.ts) asks each at the moment today's system makes,
-- or would make, the same call, and logs Jev's answer beside today's answer, or
-- beside the later truth where today's system makes no call:
--
--   sender_role     a message whose who-to-whom stamp says the sender is
--                   unknown: which party sent it. Compared later with the stamp
--                   once it names the sender (the ladder or a person).
--   visit_happened  a booking whose day passed with the status unmoved (the
--                   story's R6 loop): did the visit happen that day. Compared
--                   later with the job's crew bookings for that day as they are
--                   recorded when read: attended, all gone from the day (moved,
--                   cancelled or deleted), a visit outcome, or the job moving on.
--   lead_alive      a quote inside the quote planner's window with customer
--                   words since: is the lead alive. Compared later with the
--                   job's outcome.
--   payment_wait    an overdue invoice the debt collector considers, with
--                   customer words since it was issued: should a reminder wait.
--                   Compared with the debt collector's own hold verdict, logged
--                   beside it as today's answer, but only where that verdict is
--                   about what the customer wrote: a reminder, or a hold that
--                   rests on the customer's words. A hold for any other reason
--                   (the customer wrote recently, we wrote recently, low
--                   confidence, an owner decision) is logged without a today's
--                   answer and is not compared.
--   email_triage    each incoming email before the full read: what it is.
--                   Compared later with its party-role stamp; where the stamp
--                   names nobody, only with what is known for sure: an
--                   automatic or bulk sender is junk, and an email placed on a
--                   job or sent from a free personal mail address is not.
--
-- Jev's answer never changes a decision; the worker writes nothing but this log.
--
-- What it changes:
--  1. context_jev_decisions: five of its checks are replaced so the five
--     points' rows are taken (the point names; the row each is about: a message,
--     a booking in job_assignments or an invoice in xero_invoices; the answers
--     Jev may give at each; today's answer, hold or remind, at payment_wait
--     only, the other four comparing with the later truth). The three earlier
--     points keep exactly their rules. No column, grant, policy or row changes.
--  2. context_jev_truth(context_jev_decisions): read only. The later truth for a
--     row of sender_role, visit_happened, lead_alive or email_triage, read from
--     the records as they are when it is asked; null while it is not known, and
--     for every other point. Service role only.
--  3. context_jev_agreement(p_since, p_until): replaced, same columns. The three
--     earlier points read exactly as before; the five follow, each compared with
--     today's answer (payment_wait) or the later truth (the others).
--  4. feature_flags.context_jev_point_<name>, one row per point, created OFF.
--     A point asks nothing until its row is on, and only while
--     context_jev_shadow_v1 is on and TYPESAFE_API_KEY is set. Once on, the
--     point's message text goes to TypeSafe in the United States and cannot be
--     called back, as for the first three points.
--
-- Replaced: public.context_jev_agreement(timestamptz,timestamptz) (20261006080000
--   body, md5 053b8b4a1b61dd2ba44a136ab1405ff5) and five checks of
--   public.context_jev_decisions (20261006080000 definitions, md5 pinned below).
-- Read, not replaced: context_job_record_date(text) (20261006011000),
--   context_linked_status(text), context_sender_key(business_events) (P4,
--   20261002110000: the whole address only on a free personal mail domain).
-- New: public.context_jev_truth(public.context_jev_decisions) (md5 520d338e6d920c3190614535bdaa5fe8).
-- This migration's own bodies, accepted on a re-apply: context_jev_agreement md5
--   acd1c143ca45f6458044719625b0f3bf, and the five checks' md5s pinned in the guard.
-- Writes no business row, schedules no cron job and adds no grant, policy or
-- view for anon or authenticated.
--
-- Rollback: supabase/rollbacks/20261007030000_context_jev_points_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Guard: the log is 20261006080000's (its columns, and each check this
-- migration replaces is that migration's or already this one's); the agreement
-- read is that migration's body or this one's; the truth read is absent or this
-- one's; the records the truth reads are there; and no point's switch is
-- already on before the first apply.
DO $guard$
DECLARE problems text[] := '{}'; cols text; live text; x record;
BEGIN
 IF to_regclass('public.context_jev_decisions') IS NULL THEN
  problems := problems || 'public.context_jev_decisions is missing (20261006080000)'::text;
 ELSE
  SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum) INTO cols
  FROM pg_attribute a WHERE a.attrelid = 'public.context_jev_decisions'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
  IF cols IS DISTINCT FROM 'id:uuid,decision_point:text,job_id:uuid,row_table:text,row_id:uuid,requested_model:text,model:text,'
    'jev_outcome:text,jev_job_id:uuid,jev_confidence:numeric(5,4),jev_answer:jsonb,current_outcome:text,current_job_id:uuid,'
    'current_answer:jsonb,latency_ms:integer,input_tokens:integer,output_tokens:integer,attempts:smallint,error_code:text,'
    'created_at:timestamp with time zone' THEN
   problems := problems || format('public.context_jev_decisions has columns %s', cols);
  END IF;
  FOR x IN SELECT * FROM (VALUES
   ('context_jev_decisions_point', 'ca9e174c248d5e8ac157a7d174c8043c', '0f04dfee7d5bb5ec30ecc3f6719fdaa6'),
   ('context_jev_decisions_row', 'cbf52fd2c4429a3e2ef97e6357cb1b29', '6d7059f8415ccf228e7b27f74e9d5060'),
   ('context_jev_decisions_point_subject', '536c68593c900917a5d39b6c0c0c6c50', '419f1f92c5baefcc901ec379cd3631ae'),
   ('context_jev_decisions_jev_outcome', '0a944bd28812f13c4c4383249445cb19', 'ba794f40dc87aebee67b42fd380fc347'),
   ('context_jev_decisions_current_outcome', '72743b38f7a126f07ede84433df45f18', 'a6d0fc57196bfa0d16c2e03b1dcd7af3')
  ) AS t(name, before_md5, after_md5) LOOP
   live := NULL;
   SELECT md5(pg_get_constraintdef(c.oid)) INTO live FROM pg_constraint c
   WHERE c.conrelid = 'public.context_jev_decisions'::regclass AND c.conname = x.name AND c.contype = 'c';
   IF live IS NULL OR live NOT IN (x.before_md5, x.after_md5) THEN
    problems := problems || format('check %s md5 %s, expected 20261006080000''s', x.name, coalesce(live, '<missing>'));
   END IF;
  END LOOP;
 END IF;
 live := NULL;
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_jev_agreement(timestamptz,timestamptz)');
 IF live IS NULL OR live NOT IN ('053b8b4a1b61dd2ba44a136ab1405ff5', 'acd1c143ca45f6458044719625b0f3bf') THEN
  problems := problems || format('public.context_jev_agreement(timestamptz,timestamptz) md5 %s, expected 20261006080000''s', coalesce(live, '<missing>'));
 END IF;
 live := NULL;
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_jev_truth(public.context_jev_decisions)');
 IF live IS NOT NULL AND live <> '520d338e6d920c3190614535bdaa5fe8' THEN
  problems := problems || format('public.context_jev_truth(public.context_jev_decisions) md5 %s, not this migration''s', live);
 END IF;
 FOR x IN SELECT * FROM (VALUES ('public.context_job_record_date(text)'), ('public.context_linked_status(text)'),
  ('public.context_sender_key(public.business_events)')) AS t(sig) LOOP
  IF to_regprocedure(x.sig) IS NULL THEN problems := problems || format('%s is missing', x.sig); END IF;
 END LOOP;
 FOR x IN SELECT * FROM (VALUES
  ('business_events', 'metadata', 'jsonb'), ('business_events', 'payload', 'jsonb'), ('business_events', 'job_id', 'uuid'),
  ('business_events', 'attribution_status', 'text'), ('business_events', 'event_type', 'text'), ('business_events', 'entity_type', 'text'),
  ('business_events', 'entity_id', 'text'),
  ('job_assignments', 'id', 'uuid'), ('job_assignments', 'job_id', 'uuid'), ('job_assignments', 'status', 'text'),
  ('job_assignments', 'scheduled_date', 'date'), ('job_assignments', 'scheduled_end', 'date'), ('job_assignments', 'role', 'text'),
  ('job_assignments', 'is_ghost', 'boolean'),
  ('job_assignments', 'started_at', 'timestamp with time zone'), ('job_assignments', 'completed_at', 'timestamp with time zone'),
  ('job_assignments', 'verified_at', 'timestamp with time zone'),
  ('job_events', 'job_id', 'uuid'), ('job_events', 'event_type', 'text'), ('job_events', 'detail_json', 'jsonb'),
  ('jobs', 'id', 'uuid'), ('jobs', 'status', 'text'), ('jobs', 'archived', 'boolean'),
  ('visit_outcomes', 'id', 'uuid'), ('visit_outcomes', 'job_id', 'uuid'), ('visit_outcomes', 'outcome', 'text'),
  ('visit_outcomes', 'visit_start', 'timestamp with time zone'), ('visit_outcomes', 'supersedes', 'uuid')
 ) AS c(tbl, col, typ) LOOP
  live := NULL;
  SELECT format_type(a.atttypid, a.atttypmod) INTO live FROM pg_attribute a
  WHERE a.attrelid = to_regclass('public.' || x.tbl) AND a.attname = x.col AND a.attnum > 0 AND NOT a.attisdropped;
  IF live IS DISTINCT FROM x.typ THEN problems := problems || format('%s.%s is %s, expected %s', x.tbl, x.col, coalesce(live, '<missing>'), x.typ); END IF;
 END LOOP;
 IF to_regclass('public.feature_flags') IS NULL THEN
  problems := problems || 'public.feature_flags is missing'::text;
 ELSIF to_regprocedure('public.context_jev_truth(public.context_jev_decisions)') IS NULL THEN
  -- The first apply: a point switched on by hand before its checks exist would ask Jev with nowhere to log.
  SELECT string_agg(f.flag_name, ', ' ORDER BY f.flag_name) INTO live FROM public.feature_flags f
  WHERE f.flag_name IN ('context_jev_point_sender_role', 'context_jev_point_visit_happened', 'context_jev_point_lead_alive',
   'context_jev_point_payment_wait', 'context_jev_point_email_triage') AND f.enabled IS TRUE;
  IF live IS NOT NULL THEN problems := problems || format('feature flag %s is already on before the first apply', live); END IF;
 END IF;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_jev_points_preimage_mismatch: %', array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The log's checks take the five points. Replaced in one statement, so no
-- row is ever written under half of them; the existing rows are checked again.
ALTER TABLE public.context_jev_decisions
 DROP CONSTRAINT IF EXISTS context_jev_decisions_point,
 DROP CONSTRAINT IF EXISTS context_jev_decisions_row,
 DROP CONSTRAINT IF EXISTS context_jev_decisions_point_subject,
 DROP CONSTRAINT IF EXISTS context_jev_decisions_jev_outcome,
 DROP CONSTRAINT IF EXISTS context_jev_decisions_current_outcome,
 ADD CONSTRAINT context_jev_decisions_point CHECK (decision_point IN ('placement', 'ledger_update_gate', 'ledger_reply_owed',
  'sender_role', 'visit_happened', 'lead_alive', 'payment_wait', 'email_triage')),
 -- The row a decision is about: a message (business_events, inbox_events), a booking (job_assignments) or an invoice (xero_invoices).
 ADD CONSTRAINT context_jev_decisions_row CHECK ((row_table IS NULL) = (row_id IS NULL)
  AND (row_table IS NULL OR row_table IN ('business_events', 'inbox_events', 'job_assignments', 'xero_invoices'))),
 -- A CASE, never an OR of comparisons: a null row_table must refuse, not pass as unknown.
 ADD CONSTRAINT context_jev_decisions_point_subject CHECK (CASE decision_point
  WHEN 'placement' THEN row_table IS NOT DISTINCT FROM 'business_events' AND row_id IS NOT NULL
  WHEN 'ledger_update_gate' THEN job_id IS NOT NULL AND (row_table IS NULL OR row_table IN ('business_events', 'inbox_events'))
  WHEN 'ledger_reply_owed' THEN job_id IS NOT NULL AND row_id IS NOT NULL AND row_table IN ('business_events', 'inbox_events')
  WHEN 'sender_role' THEN row_table IS NOT DISTINCT FROM 'business_events' AND row_id IS NOT NULL
  WHEN 'email_triage' THEN row_table IS NOT DISTINCT FROM 'business_events' AND row_id IS NOT NULL
  WHEN 'visit_happened' THEN row_table IS NOT DISTINCT FROM 'job_assignments' AND row_id IS NOT NULL AND job_id IS NOT NULL
  WHEN 'lead_alive' THEN row_table IS NOT DISTINCT FROM 'business_events' AND row_id IS NOT NULL AND job_id IS NOT NULL
  WHEN 'payment_wait' THEN row_table IS NOT DISTINCT FROM 'xero_invoices' AND row_id IS NOT NULL AND job_id IS NOT NULL
  ELSE false END),
 ADD CONSTRAINT context_jev_decisions_jev_outcome CHECK (jev_outcome IS NULL
  OR (decision_point = 'placement' AND jev_outcome IN ('job', 'several', 'none'))
  OR (decision_point = 'ledger_update_gate' AND jev_outcome IN ('change', 'no_change'))
  OR (decision_point = 'ledger_reply_owed' AND jev_outcome IN ('owed', 'not_owed'))
  OR (decision_point = 'sender_role' AND jev_outcome IN ('customer', 'other_party', 'insurer_builder', 'supplier', 'crew_staff', 'unknown'))
  OR (decision_point = 'visit_happened' AND jev_outcome IN ('yes', 'no', 'unsure'))
  OR (decision_point = 'lead_alive' AND jev_outcome IN ('alive', 'declined', 'paused', 'gone_elsewhere', 'unsure'))
  OR (decision_point = 'payment_wait' AND jev_outcome IN ('paid', 'disputes', 'asked_for_time', 'none'))
  OR (decision_point = 'email_triage' AND jev_outcome IN ('customer_job', 'supplier', 'insurer_builder', 'council', 'internal', 'marketing_junk'))),
 -- Today's answer: payment_wait's is the debt collector's verdict (the worker logs a hold that rests on no customer words with
 -- none, the verdict kept in current_answer); the other four new points are compared with the later truth, so none.
 ADD CONSTRAINT context_jev_decisions_current_outcome CHECK (current_outcome IS NULL
  OR (decision_point = 'placement' AND current_outcome IN ('job', 'several', 'none'))
  OR (decision_point = 'ledger_update_gate' AND current_outcome IN ('change', 'no_change'))
  OR (decision_point = 'ledger_reply_owed' AND current_outcome IN ('owed', 'not_owed'))
  OR (decision_point = 'payment_wait' AND current_outcome IN ('hold', 'remind')));
COMMENT ON TABLE public.context_jev_decisions IS
 'Context Jev decisions (20261006080000, five points added by 20261007030000): one row per request the context worker sent to Jev (TypeSafe, jev-1.13.0) in shadow, beside today''s answer at the same decision point (placement, ledger_update_gate, ledger_reply_owed, and the watch points sender_role, visit_happened, lead_alive, payment_wait, email_triage), or beside the later truth (context_jev_truth) where today''s system makes no call. Jev''s answer never changes a decision. Ids, outcomes, numbers and codes only, never message words. Written by the worker with the service role (insert only); read with context_jev_agreement. Retention: keep 180 days; nothing deletes rows automatically, older rows may be deleted by hand. Flags: feature_flags.context_jev_shadow_v1 and context_jev_point_<name> (created off).';

-- 2. The later truth, read from the records as they are now. Null while not
-- known, and for any point compared with today's answer.
--   sender_role     the stamp once it names the sender: crew or staff is
--                   crew_staff; customer, supplier, insurer_builder as stamped;
--                   a council (still unknown, basis council) is other_party.
--   email_triage    the stamp first: our crew or staff internal; supplier and
--                   insurer_builder as stamped; basis council council; the
--                   customer customer_job. Where the stamp names nobody (or
--                   there is no stamp yet), only what is known for sure:
--                   resting on no job (admin bucket, unplaced), an automatic or
--                   bulk sender (the email reader's own call, payload
--                   sender_kind or the stamp's basis automated, or one of the
--                   reader's no-reply, notification or newsletter mailbox
--                   names, outlook_mail.ts NO_REPLY_LOCAL) marketing_junk;
--                   placed on a job, or resting on no job from a free personal
--                   mail address (context_sender_key keeps the whole address
--                   only on a free-mail domain), not_junk: a real sender whose
--                   kind is not known, which judges a junk call only; anything
--                   else not known. No person marks an email junk today, and
--                   who wrote an email placed on a job is not known from the
--                   placement, so neither is read as an answer.
--   visit_happened  the job's crew bookings for the day asked
--                   (current_answer.booking_date, the booking's date when it
--                   was asked; unreadable, not known), as recorded now, observer
--                   copies never counted: one still on that day started,
--                   completed, verified or marked complete, yes; a visit
--                   outcome for that day (the current one: a correction
--                   supersedes it) says which; none left on that day (each
--                   one there cancelled, deleted, declined or disputed, or the
--                   asked booking moved to another day, or deleted with its
--                   deletion recorded: business_events
--                   schedule.assignment_deleted for it, job_events
--                   assignment_deleted for the job and that day, or job_events
--                   assignment_removed naming it or that day), no; the job moved
--                   on to complete, invoiced, final payment or a review request
--                   while a crew booking still sits on that day and none is
--                   booked after it, yes. A booking's own record counts only
--                   while it sits on the day asked: a booking moved and
--                   completed on another day says nothing about this one.
--   lead_alive      the job's status now: accepted or any later stage, won;
--                   lost, cancelled or archived, lost; still quoted (or back to
--                   draft), not known yet.
-- A definer, so the agreement read reaches the records whoever may call it (service role only); the search path is
-- fixed for that reason, and every table is schema-qualified.
CREATE OR REPLACE FUNCTION public.context_jev_truth(d public.context_jev_decisions) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 SELECT CASE d.decision_point
  WHEN 'sender_role' THEN (
   SELECT CASE WHEN s.role IN ('crew', 'staff') THEN 'crew_staff'
               WHEN s.role IN ('customer', 'supplier', 'insurer_builder') THEN s.role
               WHEN s.basis = 'council' THEN 'other_party' END
   FROM public.business_events e
   CROSS JOIN LATERAL (SELECT e.metadata #>> '{party_roles,sender_role}' AS role, e.metadata #>> '{party_roles,basis}' AS basis) s
   WHERE e.id = d.row_id)
  WHEN 'email_triage' THEN (
   SELECT CASE WHEN s.role IN ('crew', 'staff') THEN 'internal'
               WHEN s.role IN ('supplier', 'insurer_builder') THEN s.role
               WHEN s.basis = 'council' THEN 'council'
               WHEN s.role = 'customer' THEN 'customer_job'
               WHEN e.job_id IS NOT NULL AND public.context_linked_status(e.attribution_status) THEN 'not_junk'
               WHEN e.job_id IS NULL AND e.attribution_status IN ('admin_bucket', 'unplaced') THEN
                CASE WHEN e.payload ->> 'sender_kind' = 'automated' OR s.basis = 'automated'
                       OR split_part(s.addr, '@', 1) ~ '^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|notifications?|notify|mailer[-_.]?daemon|postmaster|bounces?|alerts?|newsletter|news|marketing|info[-_.]?noreply)([-_.+].*)?$'
                       THEN 'marketing_junk'
                     WHEN position('@' IN coalesce(public.context_sender_key(e), '')) > 0 THEN 'not_junk' END END
   FROM public.business_events e
   CROSS JOIN LATERAL (SELECT e.metadata #>> '{party_roles,sender_role}' AS role, e.metadata #>> '{party_roles,basis}' AS basis,
     CASE WHEN a.addr ~ '^[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$' THEN a.addr END AS addr
    FROM (SELECT lower(btrim(coalesce(substring(r.raw FROM '<([^<>]*)>'), r.raw, ''))) AS addr
     FROM (SELECT coalesce(e.payload ->> 'from', e.payload ->> 'from_email', e.payload ->> 'sender', e.payload ->> 'email') AS raw) r) a) s
   WHERE e.id = d.row_id)
  WHEN 'visit_happened' THEN (
   SELECT CASE WHEN v.day IS NULL THEN NULL
               WHEN v.attended THEN 'yes'
               WHEN EXISTS (SELECT 1 FROM public.visit_outcomes o WHERE o.job_id = d.job_id AND o.outcome = 'happened'
                 AND (o.visit_start AT TIME ZONE 'Australia/Perth')::date = v.day
                 AND NOT EXISTS (SELECT 1 FROM public.visit_outcomes c WHERE c.supersedes = o.id)) THEN 'yes'
               WHEN EXISTS (SELECT 1 FROM public.visit_outcomes o WHERE o.job_id = d.job_id AND o.outcome = 'did_not_happen'
                 AND (o.visit_start AT TIME ZONE 'Australia/Perth')::date = v.day
                 AND NOT EXISTS (SELECT 1 FROM public.visit_outcomes c WHERE c.supersedes = o.id)) THEN 'no'
               WHEN v.live_on_day = 0 AND (v.on_day > 0 OR v.asked_moved OR (NOT v.asked_kept AND v.deleted)) THEN 'no'
               WHEN v.live_on_day > 0 AND NOT v.later
                 AND (SELECT j.status FROM public.jobs j WHERE j.id = d.job_id) IN ('complete', 'invoiced', 'final_payment', 'get_review') THEN 'yes' END
   FROM (
    SELECT x.day,
     count(*) FILTER (WHERE b.on_day) AS on_day,
     count(*) FILTER (WHERE b.on_day AND b.live) AS live_on_day,
     coalesce(bool_or(b.on_day AND b.attended), false) AS attended,
     coalesce(bool_or(b.live AND b.scheduled_date > x.day), false) AS later,
     coalesce(bool_or(b.id = d.row_id), false) AS asked_kept,
     coalesce(bool_or(b.id = d.row_id AND NOT b.on_day), false) AS asked_moved,
     EXISTS (SELECT 1 FROM public.business_events be WHERE be.entity_type = 'crew_assignment' AND be.entity_id = d.row_id::text
       AND be.event_type = 'schedule.assignment_deleted')
     OR EXISTS (SELECT 1 FROM public.job_events je WHERE je.job_id = d.job_id
       AND ((je.event_type = 'assignment_deleted'
             AND public.context_job_record_date(coalesce(je.detail_json ->> 'date', je.detail_json ->> 'scheduled_date')) = x.day)
         OR (je.event_type = 'assignment_removed'
             AND (je.detail_json -> 'removed_assignments' @> jsonb_build_array(jsonb_build_object('id', d.row_id::text))
               OR je.detail_json -> 'removed_dates' @> jsonb_build_array(x.day::text))))) AS deleted
    FROM (SELECT public.context_job_record_date(d.current_answer ->> 'booking_date') AS day) x
    LEFT JOIN LATERAL (
     SELECT a.id, a.scheduled_date,
      a.scheduled_date <= x.day AND greatest(a.scheduled_date, a.scheduled_end) >= x.day AS on_day,
      lower(coalesce(a.status, '')) NOT IN ('cancelled', 'deleted', 'declined', 'disputed') AS live,
      a.started_at IS NOT NULL OR a.completed_at IS NOT NULL OR a.verified_at IS NOT NULL
       OR lower(coalesce(a.status, '')) IN ('complete', 'completed') AS attended
     FROM public.job_assignments a
     WHERE a.job_id = d.job_id AND NOT (coalesce(a.is_ghost, false) OR coalesce(a.role, '') = 'observer')) b ON true
    GROUP BY x.day) v)
  WHEN 'lead_alive' THEN (
   SELECT CASE WHEN j.status IN ('accepted', 'partially_accepted', 'awaiting_deposit', 'deposit', 'approvals', 'order_materials', 'awaiting_supplier',
                 'schedule_install', 'scheduled', 'in_progress', 'processing', 'complete', 'invoiced', 'final_payment', 'get_review', 'rectification') THEN 'won'
               WHEN j.status IN ('lost', 'cancelled', 'archived') OR j.archived IS TRUE THEN 'lost' END
   FROM public.jobs j WHERE j.id = d.job_id)
 END
$fn$;
COMMENT ON FUNCTION public.context_jev_truth(public.context_jev_decisions) IS
 'Context Jev points (20261007030000): read only. The later truth for a Jev shadow row whose today''s answer is not known when it is asked: sender_role (the party-roles stamp once it names the sender: crew_staff, customer, supplier, insurer_builder; basis council other_party), email_triage (the stamp: internal, supplier, insurer_builder, council, customer_job; where it names nobody, on no job an automatic or bulk sender marketing_junk; placed on a job, or on no job from a free personal mail address, not_junk, a real sender of no known kind that judges a junk call only; else not known), visit_happened (the job''s crew bookings for the day asked, observer copies never: one still on that day started, completed, verified or complete yes; the current visit outcome for that day; none left on that day, every one there cancelled, deleted, declined or disputed, or the asked booking moved to another day or deleted with its deletion recorded, no; the job moved on to complete, invoiced, final_payment or get_review while a crew booking still sits on that day and none is booked after it yes), lead_alive (the job: accepted or later won; lost, cancelled or archived lost). Null while not known and for every other point. Read from the records as they are when asked. Service role only.';

-- 3. Agreement by decision point and confidence band. The three earlier points
-- read exactly as before. The five new points: payment_wait is compared with
-- today's answer (the debt collector's verdict), the other four with the later
-- truth; compared means that answer or truth is known now, so answered minus
-- compared is what still waits for it, or has none to wait for (payment_wait's
-- holds for another reason; email_triage's non-junk answers on a real sender of
-- no known kind, until a stamp names the sender).
--   compared payment_wait: a reminder, or a hold that rests on the customer's
--            own words (current_answer.customer_held: payment_unconfirmed,
--            customer_waiting or hold), never a hold for another reason (the
--            worker logs those with no today's answer; one logged with it is
--            still not compared). email_triage: a not_junk truth (a real
--            sender of no known kind) judges a junk call only, so it is
--            compared only when Jev said marketing_junk.
--   agreed   the same outcome, and: lead_alive alive or paused is won, declined
--            or gone_elsewhere is lost; payment_wait none is remind and paid,
--            disputes or asked_for_time is hold.
--   unsafe   what would have done harm had Jev decided: sender_role, Jev named
--            the customer when the stamp names someone else, or someone else
--            when it names the customer; visit_happened, Jev said it happened
--            and it did not; lead_alive, Jev said declined or gone elsewhere
--            and the job was won; payment_wait, Jev said nothing waits while
--            the debt collector held on the customer's words; email_triage,
--            Jev said marketing or junk and the email was anything else, a real
--            sender of no known kind included.
CREATE OR REPLACE FUNCTION public.context_jev_agreement(p_since timestamptz DEFAULT NULL, p_until timestamptz DEFAULT NULL)
RETURNS TABLE (decision_point text, confidence_band text, answered bigint, compared bigint, agreed bigint, agreement numeric,
 unsafe bigint, failed bigint, pairs jsonb)
LANGUAGE sql STABLE SET search_path = pg_catalog, public
AS $fn$
 WITH win AS (
  SELECT coalesce(p_until, now()) AS until_, coalesce(p_since, coalesce(p_until, now()) - interval '14 days') AS since_
 ), rows_ AS MATERIALIZED (
  SELECT j.decision_point AS point, j.jev_outcome, j.jev_job_id, j.jev_confidence, j.current_job_id, j.error_code,
   CASE WHEN j.decision_point IN ('sender_role', 'visit_happened', 'lead_alive', 'email_triage') THEN public.context_jev_truth(j)
        WHEN j.decision_point = 'payment_wait' AND j.current_outcome = 'hold' AND (j.current_answer ->> 'customer_held') IS DISTINCT FROM 'true' THEN NULL
        ELSE j.current_outcome END AS against
  FROM public.context_jev_decisions j CROSS JOIN win
  WHERE j.created_at >= win.since_ AND j.created_at < win.until_
 ), d AS (
  SELECT r.point, r.jev_outcome, r.error_code,
   CASE WHEN r.jev_confidence IS NULL THEN NULL WHEN r.jev_confidence >= 0.9 THEN '0.90-1.00' WHEN r.jev_confidence >= 0.8 THEN '0.80-0.90'
        WHEN r.jev_confidence >= 0.5 THEN '0.50-0.80' ELSE '0.00-0.50' END AS band,
   (r.jev_outcome IS NOT NULL AND r.against IS NOT NULL
    AND (r.point <> 'email_triage' OR r.against <> 'not_junk' OR r.jev_outcome = 'marketing_junk')) AS is_compared,
   CASE r.point
    WHEN 'lead_alive' THEN (r.jev_outcome IN ('alive', 'paused') AND r.against = 'won') OR (r.jev_outcome IN ('declined', 'gone_elsewhere') AND r.against = 'lost')
    WHEN 'payment_wait' THEN (r.jev_outcome = 'none' AND r.against = 'remind') OR (r.jev_outcome IN ('paid', 'disputes', 'asked_for_time') AND r.against = 'hold')
    ELSE (r.jev_outcome = r.against AND (r.jev_outcome <> 'job' OR r.jev_job_id = r.current_job_id)) END AS is_agreed,
   CASE r.point
    WHEN 'placement' THEN r.jev_outcome = 'job' AND (r.against <> 'job' OR r.jev_job_id <> r.current_job_id)
    WHEN 'ledger_update_gate' THEN r.jev_outcome = 'no_change' AND r.against = 'change'
    WHEN 'ledger_reply_owed' THEN r.jev_outcome = 'not_owed' AND r.against = 'owed'
    WHEN 'sender_role' THEN r.jev_outcome <> 'unknown' AND (r.jev_outcome = 'customer') <> (r.against = 'customer')
    WHEN 'visit_happened' THEN r.jev_outcome = 'yes' AND r.against = 'no'
    WHEN 'lead_alive' THEN r.jev_outcome IN ('declined', 'gone_elsewhere') AND r.against = 'won'
    WHEN 'payment_wait' THEN r.jev_outcome = 'none' AND r.against = 'hold'
    WHEN 'email_triage' THEN r.jev_outcome = 'marketing_junk' AND r.against <> 'marketing_junk' END AS is_unsafe,
   CASE WHEN r.point = 'placement' AND r.jev_outcome = 'job' AND r.against = 'job' AND r.jev_job_id <> r.current_job_id THEN 'job>other_job'
        ELSE r.jev_outcome || '>' || r.against END AS pair
  FROM rows_ r
 ), points (point, point_rank) AS (
  VALUES ('placement', 1), ('ledger_update_gate', 2), ('ledger_reply_owed', 3),
   ('sender_role', 4), ('visit_happened', 5), ('lead_alive', 6), ('payment_wait', 7), ('email_triage', 8)
 ), bands (band, band_rank) AS (
  VALUES ('all', 0), ('0.90-1.00', 1), ('0.80-0.90', 2), ('0.50-0.80', 3), ('0.00-0.50', 4)
 ), cell AS (
  SELECT p.point, p.point_rank, b.band, b.band_rank, d.jev_outcome, d.error_code, d.is_compared, d.is_agreed, d.is_unsafe, d.pair
  FROM points p CROSS JOIN bands b
  LEFT JOIN d ON d.point = p.point AND (b.band = 'all' OR d.band = b.band)
 ), pair_counts AS (
  SELECT c.point, c.band, jsonb_object_agg(c.pair, c.n) AS pairs
  FROM (SELECT point, band, pair, count(*) AS n FROM cell WHERE is_compared GROUP BY point, band, pair) c
  GROUP BY c.point, c.band
 )
 SELECT c.point, c.band,
  count(*) FILTER (WHERE c.jev_outcome IS NOT NULL),
  count(*) FILTER (WHERE c.is_compared),
  count(*) FILTER (WHERE c.is_compared AND c.is_agreed),
  round((count(*) FILTER (WHERE c.is_compared AND c.is_agreed))::numeric / nullif(count(*) FILTER (WHERE c.is_compared), 0), 4),
  count(*) FILTER (WHERE c.is_compared AND c.is_unsafe),
  CASE WHEN c.band = 'all' THEN count(*) FILTER (WHERE c.error_code IS NOT NULL) ELSE 0 END,
  coalesce(min(pc.pairs::text)::jsonb, '{}'::jsonb)
 FROM cell c LEFT JOIN pair_counts pc ON pc.point = c.point AND pc.band = c.band
 GROUP BY c.point, c.point_rank, c.band, c.band_rank
 ORDER BY c.point_rank, c.band_rank
$fn$;
COMMENT ON FUNCTION public.context_jev_agreement(timestamptz, timestamptz) IS
 'Context Jev points (20261007030000): read only. Per decision point (placement, ledger_update_gate, ledger_reply_owed, sender_role, visit_happened, lead_alive, payment_wait, email_triage) and band of Jev''s confidence (all, 0.90-1.00, 0.80-0.90, 0.50-0.80, 0.00-0.50): answered, compared (today''s answer, or the later truth from context_jev_truth for sender_role, visit_happened, lead_alive and email_triage, is known; payment_wait compares only a reminder or a hold resting on the customer''s words, and email_triage''s not_junk only a junk call), agreed, agreement (agreed / compared, null when none), unsafe (would have done harm had Jev decided), failed (band all: requests with no answer) and pairs ("jev>today or truth" counts) over created_at in [p_since, p_until), default the 14 days before now. The first three points read exactly as in 20261006080000. Service role only.';

-- 4. Access: service role only.
REVOKE ALL ON FUNCTION public.context_jev_truth(public.context_jev_decisions) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_jev_agreement(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_jev_truth(public.context_jev_decisions) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_jev_agreement(timestamptz, timestamptz) TO service_role;

-- 5. The five switches, created OFF. Turning one on needs the owner's word
-- (docs/jev.md in secureworks-jarvis, "The five watch points").
INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT v.flag_name, false, v.description
FROM (VALUES
 ('context_jev_point_sender_role', 'Jev watch point sender_role (20261007030000): for a message whose who-to-whom stamp says the sender is unknown, the context worker asks Jev (TypeSafe, jev-1.13.0) which party sent it and logs the answer in context_jev_decisions, compared later with the stamp. Watch only: Jev never changes a decision. Runs only while context_jev_shadow_v1 is on and TYPESAFE_API_KEY is set. Once on, the message''s words (contact details stripped) go to TypeSafe in the United States. Owner''s word to turn on.'),
 ('context_jev_point_visit_happened', 'Jev watch point visit_happened (20261007030000): for a booking whose day passed with the status unmoved (the story''s R6 loop), the context worker asks Jev whether the visit happened, from that day''s crew texts, clock times, saved photo and document text and reports, and logs it in context_jev_decisions, compared later with the attendance record or the status. Watch only. Runs only while context_jev_shadow_v1 is on and TYPESAFE_API_KEY is set. Once on, that day''s words go to TypeSafe in the United States. Owner''s word to turn on.'),
 ('context_jev_point_lead_alive', 'Jev watch point lead_alive (20261007030000): for a quote inside the quote planner''s window with customer words since, the context worker asks Jev whether the lead is alive when the planner runs, and logs it in context_jev_decisions, compared later with the job''s outcome. Watch only. Runs only while context_jev_shadow_v1 is on and TYPESAFE_API_KEY is set. Once on, the customer''s and our messages since the quote go to TypeSafe in the United States. Owner''s word to turn on.'),
 ('context_jev_point_payment_wait', 'Jev watch point payment_wait (20261007030000): for an overdue invoice the debt collector considers, with customer words since it was issued, the context worker asks Jev whether a reminder should wait (paid, disputes, asked for time, none) when the debt collector runs, and logs it in context_jev_decisions beside the debt collector''s own hold verdict. Watch only: nothing is sent. Runs only while context_jev_shadow_v1 is on and TYPESAFE_API_KEY is set. Once on, the customer''s and our messages since the invoice go to TypeSafe in the United States. Owner''s word to turn on.'),
 ('context_jev_point_email_triage', 'Jev watch point email_triage (20261007030000): for each incoming email, the context worker asks Jev what it is (customer about a job, supplier, builder or insurer, council, internal, marketing or junk) and logs it in context_jev_decisions, compared later with its placement and party-role stamp. Watch only. Runs only while context_jev_shadow_v1 is on and TYPESAFE_API_KEY is set. Once on, each email''s subject and first words go to TypeSafe in the United States. Owner''s word to turn on.')
) AS v(flag_name, description)
WHERE NOT EXISTS (SELECT 1 FROM public.feature_flags f WHERE f.flag_name = v.flag_name);
