-- History daily (7 Oct 2026, done-definition row 4: "Every live job has its
-- past GHL texts/calls/emails, its Outlook email history and its Xero history
-- loaded; loads run on their own daily until complete").
--
-- Three things, one migration:
--  A. The daily Xero top-up. The Xero history load ran once by hand on 5 Oct
--     (context_xero_evidence_backfill, 20261005230000). Invoices that reached
--     the Xero mirror after it have no raised, authorised or paid evidence row,
--     and nothing tops the load up (scorecard row 4: "no active cron job for:
--     xero"). trigger_xero_history_daily() writes what is missing once a day
--     through that same writer and records one run row a day.
--  B. The CRM history load's job list, widened. context_ghl_history_live_jobs()
--     (M4, the one live-job list of the CRM load, its link step, transcripts,
--     the email history scope and the document text lane) keeps every row M4
--     gives (the captain's ruling of 24 Sep 2026, quotes sent in the last 60
--     days included) and adds every live job the lead rule keeps monitored.
--  C. One read for the scorecard v2: per monitored live job, whether its CRM
--     history is loaded, tried with no contact, or missing, and why.
--
-- The rulings it follows.
--  Owner, 7 Oct 2026: everything runs on the new AI reader (the job ledger);
--   done means all 14 rows green and live; a lead with no progress stops being
--   monitored 28 days after the newer of its newest quote send and the
--   customer's newest inbound message (on 7 Oct about 09:00 Perth: 364 of the
--   862 live jobs dropped out, 498 stayed monitored); nothing messages a
--   customer or staff, moves money or changes a job status without his yes.
--  Captain, 24 Sep 2026 (M4, 20260925031500): every backfill covers currently
--   live jobs only (accepted, scheduled, in progress, plus quotes sent in the
--   last 60 days), never closed jobs; each live job contact's history loads
--   from its first GHL message forward.
--
-- The lead rule is computed INLINE here, by context_history_monitored_jobs(),
-- until the lead-rule PR merges: that PR (branch ctx/lead-cutoff, built on PR
-- 978) adds public.context_lead_monitored(uuid, timestamptz). The moment a
-- function of that signature exists whose result has job_id uuid and
-- monitored boolean, it decides and this inline copy only reports beside it
-- (rule = 'context_lead_monitored', inline_monitored kept for comparison). A
-- function of any other shape is not read, and one that fails leaves the
-- inline rule deciding with a WARNING (rule '..._fallback'). The inline rule:
--  - live: jobs.status not cancelled, draft, archived, complete, completed or
--    lost (the done definition);
--  - a lead: nothing has moved the job past quoted by the instant (no
--    acceptance on the job or a quote document, no customer invoice issued or
--    paid, no standing crew booking, no stage stamp past quoted, no status
--    change into a status past quoted; a job whose status is past quoted is
--    past quoted throughout), as the lead-rule draft reads it;
--  - its newest quote send: the latest of jobs.quoted_at, a quote document's
--    sent_at and the app's quote_sent event; the customer's newest inbound
--    message: the latest inbound text, email or call on the job whose
--    party-roles stamp names the customer as the sender;
--  - not monitored: a lead whose newer of those two is 28 days or more before
--    the instant. A quote never sent starts no clock.
--  Re-measured read only on production at 12:17 Perth on 7 Oct: 862 live, 496
--  monitored, 366 not (two more leads passed their 28 days since 09:00); the
--  rule gave 364 between 08:18 and 10:08 Perth, the figure of the ruling.
--
-- B in numbers (read only, production, 7 Oct 12:17 Perth). The load's list
-- had 485 jobs; 449 of them are monitored live jobs. The widening adds 47:
-- 13 invoiced and 3 get_review jobs (statuses M4's allow-list never named),
-- 15 quoted leads whose quote was never sent, 13 quoted leads whose last
-- send is over 60 days old but whose customer wrote within 28 days, and 3
-- archived-flag jobs at work (in progress, final payment, rectification; M4
-- left out every archived-flag job; the done definition and the lead rule
-- count them live). 36 quotes sent in the
-- last 60 days are no longer monitored but stay on the list by the 24 Sep
-- ruling. New list: 532 jobs. Of the 496 monitored live jobs today: 161 have
-- their CRM history loaded, 291 were tried and have no contact (279 not in
-- GHL, 11 with no phone or email, 1 ambiguous), and 44 are missing, every one
-- of them among the 47 added: 39 jobs whose 37 contacts were never loaded and
-- 5 never link-tried. At the schedule's 25 jobs a cycle (one cycle every 15
-- minutes, 250 jobs a day until 12 Oct, then 100) they are taken in about two
-- cycles. Side effects of the one shared list, measured: the document text
-- lane gains 100 documents on 24 of the added jobs (8 already read; at the
-- measured 21.7% with no text layer about 20 go to the AI vision reader once,
-- under its 100-a-day cap); the email history scope gains their job numbers
-- and client emails, but every 60-day email window has finished, so nothing
-- runs on it now; the transcript fetcher may fetch older call transcripts of
-- the 37 contacts once their calls load (GHL reads, no AI call); each loaded
-- contact's jobs go on the old fact reader's catch-up list through B-2's
-- hand-over (context_ghl_history_request_reads, unchanged here), which spends
-- old-reader calls only while that reader still runs.
--
-- A in numbers: 368 invoiced live jobs, 365 with Xero evidence (99.2%);
-- context_xero_evidence_backfill_plan() lists 14 missing rows (6 raised, 8
-- authorised) on 11 invoices of 11 jobs, 3 of which have no Xero row at all.
-- The plan reads in 38 ms; the first run writes those 14 rows.
--
-- What it adds (new, none replaces an existing body unless named):
--  1. context_history_daily_policy(): every number and name, in one place.
--  2. context_history_monitored_jobs(p_as_of, p_job_ids): the lead rule, one
--     row per live job (or per live job of p_job_ids).
--  3. REPLACES context_ghl_history_live_jobs() (M4 body, md5
--     49eb23015b724a29058c11b2743954bf): same signature, same columns, same
--     values on every row M4 gives; plus every monitored live job M4 leaves
--     out, live_basis 'status' (a status past quoted) or 'lead_monitored' (a
--     quoted lead the lead rule keeps), tier as M4's (quotes 4). Never a
--     holding job (metadata.do_not_schedule), as M4.
--  4. context_history_crm_jobs(p_job_ids) and context_history_crm_summary():
--     the read for the scorecard v2 (section C).
--  5. trigger_xero_history_daily(p_limit) and the pg_cron job
--     xero-history-daily at 19:30 UTC (03:30 Perth), gated on the capture lane
--     like every capture job; the name the scorecard v2's
--     history_schedules.xero should carry.
--  6. context_history_xero_daily_status(): the top-up's cron job, last run
--     and what is still missing.
--  7. REPLACES automation_switch_cron_lanes() (20261005210000 body, md5
--     99e6d70e80a79e548f2478b65fc6cd78) with one row added,
--     ('xero-history-daily', 'capture'); left alone when the live list already
--     names that job on the capture lane.
--
-- Called, never replaced (pinned in the guard): context_xero_evidence_backfill
-- and its plan (B-4), record_capture_run (F1b), context_ghl_history_policy
-- (M4), automation_lane_enabled.
--
-- Not changed: the CRM load's edge function, its daily limit, the link step's
-- rules and B-2's reading hand-over; the scorecard (only the scorecard v2
-- builder replaces it); PR 978's functions; the ledger; placement. No flag,
-- setting, job, contact or evidence row is written by the migration itself;
-- the cron job writes Xero evidence rows (capture_mode backfill) from its first
-- run, and the widened list lets the scheduled CRM cycle link and load the
-- added jobs (a link writes jobs.ghl_contact_id only on an exact phone or email
-- match to exactly one GHL contact, M4's rule, reversible through
-- reverse_ghl_contact_link). Nothing messages anyone, moves money or changes a
-- job status.
--
-- Stop the top-up at once: SELECT cron.unschedule('xero-history-daily'); (or
-- turn the capture lane off). Undo one run's rows:
-- scripts/context-history-xero-daily-undo.sql (guarded, ends in ROLLBACK).
-- Rollback: supabase/rollbacks/20261007050000_context_history_daily_down.sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Pre-image guard. Reports every problem at once.
DO $guard$
DECLARE problems text[] := '{}'; live text; x record; cmd text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  -- Replaced: M4's body, or this migration's (a re-apply).
  ('public.context_ghl_history_live_jobs()', ARRAY['49eb23015b724a29058c11b2743954bf','036457fdaa73579ab9cc9881d3b82aef'], false),
  -- Called, never replaced: the live bodies this slice was built against.
  ('public.context_xero_evidence_backfill(boolean,integer)', ARRAY['eb9a51fc91bb4341e4a56b4e65552aae'], false),
  ('public.context_xero_evidence_backfill_plan()', ARRAY['805f818bffd9af3b0ead62f5b5fb80ff'], false),
  ('public.record_capture_run(jsonb)', ARRAY['db03c98a6da49f128595342f5a93f84c'], false),
  ('public.context_ghl_history_policy()', ARRAY['ae330644d6d87cf4be51f7adb2191891'], false),
  ('public.automation_lane_enabled(text)', NULL::text[], false),
  -- New: absent, or already this migration's body.
  ('public.context_history_daily_policy()', ARRAY['082cfb2d05865a98ddcac858dc24289c'], true),
  ('public.context_history_monitored_jobs(timestamp with time zone,uuid[])', ARRAY['22f86bc4ab1afc7ea60e35581074bb51'], true),
  ('public.context_history_crm_jobs(uuid[])', ARRAY['71a418b1b6636b82a28f9b53b9807cf9'], true),
  ('public.context_history_crm_summary()', ARRAY['ccc16e94e94135fda3ba80cf7ac60c60'], true),
  ('public.trigger_xero_history_daily(integer)', ARRAY['f847c00e65be62ceb1cc9a870059fa33'], true),
  ('public.context_history_xero_daily_status()', ARRAY['4726da475aa9d5f8e9ff8c01e65fbd5e'], true)
 ) AS t(sig, accepted, may_be_absent) LOOP
  live := NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS NULL AND x.may_be_absent THEN CONTINUE; END IF;
  IF live IS NULL OR (x.accepted IS NOT NULL AND NOT live = ANY (x.accepted)) THEN
   problems := problems || format('%s md5 %s', x.sig, coalesce(live, '<missing>'));
  END IF;
 END LOOP;
 -- The lane list: the 20261005210000 body, this migration's, or any body that
 -- already names xero-history-daily on the capture lane (then left alone).
 live := NULL;
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure('public.automation_switch_cron_lanes()');
 IF live IS NULL THEN
  problems := problems || 'public.automation_switch_cron_lanes() md5 <missing>'::text;
 ELSIF live NOT IN ('99e6d70e80a79e548f2478b65fc6cd78', '81cbebf914f537b0b85870196cbd0f75')
  AND NOT EXISTS (SELECT 1 FROM public.automation_switch_cron_lanes() l WHERE l.cron_jobname = 'xero-history-daily' AND l.lane = 'capture') THEN
  problems := problems || format('public.automation_switch_cron_lanes() md5 %s', live);
 END IF;
 -- Any other overload of a name this migration owns is a live change nobody read.
 FOR x IN SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('context_history_daily_policy', 'context_history_monitored_jobs',
   'context_history_crm_jobs', 'context_history_crm_summary', 'trigger_xero_history_daily', 'context_history_xero_daily_status',
   'context_ghl_history_live_jobs')
  AND p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' NOT IN (
   'context_history_daily_policy()', 'context_history_monitored_jobs(p_as_of timestamp with time zone, p_job_ids uuid[])',
   'context_history_crm_jobs(p_job_ids uuid[])', 'context_history_crm_summary()', 'trigger_xero_history_daily(p_limit integer)',
   'context_history_xero_daily_status()', 'context_ghl_history_live_jobs()') LOOP
  problems := problems || format('unexpected overload %s', x.sig);
 END LOOP;
 -- The cron job, if it exists, runs this migration's command.
 IF to_regclass('cron.job') IS NOT NULL THEN
  EXECUTE 'SELECT string_agg(command, '' | '') FROM cron.job WHERE jobname = ''xero-history-daily''' INTO cmd;
  IF cmd IS NOT NULL AND cmd <> 'SELECT public.trigger_xero_history_daily() WHERE public.automation_lane_enabled(''capture'')' THEN
   problems := problems || 'cron job xero-history-daily exists with another command'::text;
  END IF;
 END IF;
 -- Tables and columns read.
 FOR x IN SELECT * FROM (VALUES
  ('jobs','id','uuid'),('jobs','job_number','text'),('jobs','status',NULL),('jobs','archived','boolean'),('jobs','metadata','jsonb'),
  ('jobs','ghl_contact_id','text'),('jobs','created_at','timestamp with time zone'),('jobs','updated_at','timestamp with time zone'),
  ('jobs','quoted_at','timestamp with time zone'),('jobs','accepted_at','timestamp with time zone'),('jobs','deposit_at','timestamp with time zone'),
  ('jobs','approvals_at','timestamp with time zone'),('jobs','processing_at','timestamp with time zone'),
  ('jobs','scheduled_at','timestamp with time zone'),('jobs','completed_at','timestamp with time zone'),
  ('job_documents','job_id','uuid'),('job_documents','type','text'),('job_documents','sent_at','timestamp with time zone'),
  ('job_documents','accepted_at','timestamp with time zone'),
  ('job_events','job_id','uuid'),('job_events','event_type','text'),('job_events','detail_json','jsonb'),('job_events','created_at','timestamp with time zone'),
  ('xero_invoices','job_id','uuid'),('xero_invoices','invoice_type','text'),('xero_invoices','status','text'),
  ('xero_invoices','invoice_date','date'),('xero_invoices','created_at','timestamp with time zone'),
  ('job_assignments','job_id','uuid'),('job_assignments','scheduled_date','date'),('job_assignments','status','text'),
  ('job_assignments','is_ghost','boolean'),('job_assignments','role','text'),('job_assignments','created_at','timestamp with time zone'),
  ('business_events','job_id','uuid'),('business_events','direction','text'),('business_events','channel','text'),
  ('business_events','event_type','text'),('business_events','metadata','jsonb'),('business_events','event_at','timestamp with time zone'),
  ('business_events','occurred_at','timestamp with time zone'),('business_events','recorded_at','timestamp with time zone'),
  ('business_events','context_captured_at','timestamp with time zone'),('business_events','provider_message_id','text'),
  ('business_events','source','text'),
  ('context_ghl_history_contacts','contact_id','text'),('context_ghl_history_contacts','status','text'),
  ('context_ghl_history_contacts','completed_at','timestamp with time zone'),
  ('context_ghl_history_link_attempts','job_id','uuid'),('context_ghl_history_link_attempts','verdict','text'),
  ('context_ghl_history_link_attempts','reason','text'),('context_ghl_history_link_attempts','last_attempt_at','timestamp with time zone'),
  ('context_capture_runs','source','text'),('context_capture_runs','status','text'),('context_capture_runs','started_at','timestamp with time zone'),
  ('context_capture_runs','finished_at','timestamp with time zone'),('context_capture_runs','counts','jsonb'),
  ('context_capture_runs','error_code','text')
 ) AS c(tbl, col, typ) LOOP
  live := NULL;
  SELECT format_type(a.atttypid, a.atttypmod) INTO live FROM pg_attribute a
  WHERE a.attrelid = to_regclass('public.' || x.tbl) AND a.attname = x.col AND a.attnum > 0 AND NOT a.attisdropped;
  IF live IS NULL OR (x.typ IS NOT NULL AND live <> x.typ) THEN
   problems := problems || format('%s.%s is %s, expected %s', x.tbl, x.col, coalesce(live, '<missing>'), coalesce(x.typ, 'present'));
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_history_daily_preimage_mismatch: %; read the live definitions before building on them', array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. Every number and name, in one place. Changed only by migration.
CREATE OR REPLACE FUNCTION public.context_history_daily_policy() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
 SELECT jsonb_build_object(
  'version', 'history-daily-v1',
  -- A job is live unless its status is one of these (the done definition).
  'live_excluded_statuses', jsonb_build_array('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost'),
  -- The lead rule (owner, 7 Oct 2026): 28 days after the newer of the newest
  -- quote send and the customer's newest inbound message.
  'lead_cutoff_days', 28,
  -- Statuses that are not past quoted (the lead-rule draft's list).
  'lead_not_past_quoted_statuses', jsonb_build_array('draft', 'quoted', 'lead', 'new', 'cancelled', 'lost', 'archived'),
  'lead_inbound_channels', jsonb_build_array('sms', 'email', 'call'),
  'lead_rule_inline', 'inline_20261007050000',
  'lead_rule_function', 'public.context_lead_monitored(uuid,timestamp with time zone)',
  -- The read's three states; a link verdict other than failed is a try (B-2).
  'crm_states', jsonb_build_array('loaded', 'tried_no_contact', 'missing'),
  'crm_tried_verdicts', jsonb_build_array('certain', 'ambiguous', 'none'),
  'ghl_contact_id_pattern', '^[A-Za-z0-9_-]{6,64}$',
  -- The daily Xero top-up: 03:30 Perth, behind the capture lane.
  'xero_cron_jobname', 'xero-history-daily',
  'xero_cron_schedule', '30 19 * * *',
  'xero_cron_command', 'SELECT public.trigger_xero_history_daily() WHERE public.automation_lane_enabled(''capture'')',
  'xero_run_source', 'xero_history_daily',
  'xero_actor', 'cron:xero-history-daily',
  'xero_batch_limit', 500)
$$;
COMMENT ON FUNCTION public.context_history_daily_policy() IS
 'History daily (20261007050000): the numbers and names of the daily history loads: the done definition''s live statuses, the lead rule (28 days after the newer of the newest quote send and the customer''s newest inbound message, owner 7 Oct 2026), the CRM read''s states and the daily Xero top-up''s cron job, schedule, run source and batch limit. Changed only by migration.';

-- 2. The lead rule: one row per live job (of p_job_ids when given), in job id
-- order. Inline until the lead-rule PR's function exists in the shape read here.
CREATE OR REPLACE FUNCTION public.context_history_monitored_jobs(p_as_of timestamptz DEFAULT now(), p_job_ids uuid[] DEFAULT NULL)
RETURNS TABLE(job_id uuid, job_number text, status text, monitored boolean, rule text, inline_monitored boolean, lead boolean,
 quote_last_sent_at timestamptz, customer_last_inbound_at timestamptz, cutoff_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
 pol jsonb := public.context_history_daily_policy();
 t timestamptz := coalesce(p_as_of, now());
 v_excluded text[] := ARRAY(SELECT jsonb_array_elements_text(pol->'live_excluded_statuses'));
 v_open text[] := ARRAY(SELECT jsonb_array_elements_text(pol->'lead_not_past_quoted_statuses'));
 v_channels text[] := ARRAY(SELECT jsonb_array_elements_text(pol->'lead_inbound_channels'));
 v_days integer := (pol->>'lead_cutoff_days')::integer;
 v_rule text := pol->>'lead_rule_inline';
 v_shape boolean := false;
 v_ids uuid[];
 v_off uuid[];
BEGIN
 -- The merged lead rule decides when it exists with job_id uuid and monitored boolean.
 SELECT count(*) = 2 INTO v_shape
 FROM pg_proc p
 CROSS JOIN LATERAL unnest(p.proargnames, p.proallargtypes, p.proargmodes::text[]) AS a(n, typ, m)
 WHERE p.oid = to_regprocedure(pol->>'lead_rule_function') AND p.proretset AND a.m IN ('o', 't')
  AND ((a.n = 'job_id' AND a.typ = 'uuid'::regtype::oid) OR (a.n = 'monitored' AND a.typ = 'boolean'::regtype::oid));
 IF v_shape THEN
  v_ids := ARRAY(SELECT jb.id FROM public.jobs jb
                 WHERE jb.status::text <> ALL (v_excluded) AND (p_job_ids IS NULL OR jb.id = ANY (p_job_ids)) ORDER BY jb.id);
  BEGIN
   EXECUTE 'SELECT coalesce(array_agg(l.id ORDER BY l.id) FILTER (WHERE m.monitored IS FALSE), ''{}''::uuid[])'
        || ' FROM unnest($1::uuid[]) AS l(id) LEFT JOIN LATERAL public.context_lead_monitored(l.id, $2) AS m ON m.job_id = l.id'
   INTO v_off USING v_ids, t;
   v_rule := 'context_lead_monitored';
  EXCEPTION WHEN OTHERS THEN
   RAISE WARNING 'context_history_monitored_jobs: context_lead_monitored failed (SQLSTATE %); the inline rule decides', SQLSTATE;
   v_off := NULL;
   v_rule := (pol->>'lead_rule_inline') || '_fallback';
  END;
 END IF;
 RETURN QUERY
 WITH live AS (
  SELECT jb.id, jb.job_number, jb.status::text AS status, jb.quoted_at, jb.accepted_at, jb.deposit_at, jb.approvals_at,
         jb.processing_at, jb.scheduled_at, jb.completed_at
  FROM public.jobs jb
  WHERE jb.status::text <> ALL (v_excluded) AND (p_job_ids IS NULL OR jb.id = ANY (p_job_ids))
 ), lr AS (
  SELECT l.id, l.job_number, l.status,
   -- When it first moved past quoted, by the instant; a status past quoted is past quoted throughout.
   CASE WHEN l.status <> ALL (v_open) THEN '-infinity'::timestamptz
    ELSE least(l.accepted_at, l.deposit_at, l.approvals_at, l.processing_at, l.scheduled_at, l.completed_at,
     (SELECT min(d.accepted_at) FROM public.job_documents d WHERE d.job_id = l.id AND d.type ILIKE '%quote%'),
     (SELECT min(coalesce((x.invoice_date::timestamp AT TIME ZONE 'Australia/Perth'), x.created_at)) FROM public.xero_invoices x
      WHERE x.job_id = l.id AND upper(coalesce(x.invoice_type, 'ACCREC')) = 'ACCREC'
       AND upper(coalesce(x.status, '')) IN ('AUTHORISED', 'SUBMITTED', 'PAID')),
     (SELECT min(a.created_at) FROM public.job_assignments a
      WHERE a.job_id = l.id AND a.scheduled_date IS NOT NULL
       AND lower(coalesce(a.status, '')) NOT IN ('cancelled', 'deleted', 'draft', 'disputed', 'declined')
       AND NOT (coalesce(a.is_ghost, false) OR coalesce(a.role, '') = 'observer')),
     (SELECT min(je.created_at) FROM public.job_events je
      WHERE je.job_id = l.id AND je.event_type IN ('status_changed', 'status_change')
       AND coalesce(je.detail_json ->> 'new_status', je.detail_json ->> 'to', je.detail_json ->> 'status') <> ALL (v_open)))
   END AS progressed_at,
   -- Only a job not past quoted needs its quote sends and the customer's messages.
   CASE WHEN l.status = ANY (v_open) THEN
    greatest(CASE WHEN l.quoted_at <= t THEN l.quoted_at END,
     (SELECT max(d.sent_at) FROM public.job_documents d WHERE d.job_id = l.id AND d.type ILIKE '%quote%' AND d.sent_at <= t),
     (SELECT max(e.created_at) FROM public.job_events e WHERE e.job_id = l.id AND e.event_type = 'quote_sent' AND e.created_at <= t))
   END AS sent_at,
   CASE WHEN l.status = ANY (v_open) THEN
    (SELECT max(coalesce(b.event_at, b.occurred_at)) FROM public.business_events b
     WHERE b.job_id = l.id AND b.direction = 'inbound' AND b.channel = ANY (v_channels)
      AND coalesce(b.event_at, b.occurred_at) <= t AND coalesce(b.context_captured_at, b.recorded_at, b.occurred_at) <= t
      AND coalesce(nullif(b.metadata #>> '{party_roles,sender_role}', ''), nullif(b.metadata #>> '{party_roles,counterpart_role}', ''),
                   CASE WHEN b.event_type LIKE 'client.%' THEN 'customer' END) = 'customer')
   END AS inbound_at
  FROM live l
 ), j AS (
  SELECT lr.*, NOT coalesce(lr.progressed_at <= t, false) AS is_lead,
   CASE WHEN lr.sent_at IS NOT NULL THEN greatest(lr.sent_at, lr.inbound_at) + make_interval(days => v_days) END AS cut
  FROM lr
 )
 SELECT j.id, j.job_number, j.status,
  CASE WHEN v_off IS NULL THEN NOT (j.is_lead AND coalesce(j.cut <= t, false)) ELSE NOT (j.id = ANY (v_off)) END,
  v_rule,
  NOT (j.is_lead AND coalesce(j.cut <= t, false)),
  j.is_lead, j.sent_at, j.inbound_at, j.cut
 FROM j ORDER BY j.id;
END $fn$;
COMMENT ON FUNCTION public.context_history_monitored_jobs(timestamptz, uuid[]) IS
 'History daily (20261007050000): the lead rule (owner, 7 Oct 2026), one row per live job (status not cancelled, draft, archived, complete, completed or lost), of p_job_ids when given, in job id order. monitored is false only for a lead (nothing moved it past quoted by p_as_of: no acceptance, no customer invoice issued or paid, no standing crew booking, no stage stamp or status change past quoted) whose newer of its newest quote send (jobs.quoted_at, a quote document''s sent_at, the app''s quote_sent event) and the customer''s newest inbound text, email or call (party-roles sender customer) is 28 days or more before p_as_of; a quote never sent starts no clock. rule: inline_20261007050000 until public.context_lead_monitored(uuid,timestamptz) exists with result columns job_id uuid and monitored boolean, then context_lead_monitored (it decides; a job it returns no row for stays monitored; inline_monitored keeps the inline answer beside it); inline_20261007050000_fallback when that function fails (WARNING). Read only; service role only.';

-- 3. The CRM history load's list: M4's rows unchanged (the captain's ruling of
-- 24 Sep 2026, quotes sent in the last 60 days included), plus every live job
-- the lead rule keeps monitored. Never a holding job.
CREATE OR REPLACE FUNCTION public.context_ghl_history_live_jobs()
RETURNS TABLE(job_id uuid, job_number text, ghl_contact_id text, status text, live_basis text, tier integer, activity_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH pol AS (SELECT public.context_ghl_history_policy() AS p,
  ARRAY(SELECT jsonb_array_elements_text(public.context_history_daily_policy()->'live_excluded_statuses')) AS excluded),
 j AS (
  SELECT jb.id, jb.job_number, nullif(btrim(jb.ghl_contact_id),'') AS contact, jb.status::text AS status, jb.created_at, jb.updated_at,
   coalesce(jb.archived,false) AS archived, jb.status::text <> ALL (pol.excluded) AS live,
   (SELECT max(d.sent_at) FROM public.job_documents d
    WHERE d.job_id=jb.id AND d.type='quote' AND d.sent_at IS NOT NULL
     AND d.sent_at>=now()-make_interval(days=>(pol.p->>'quote_sent_days')::integer) AND d.sent_at<=now()) AS quote_sent_at,
   jb.status::text IN (SELECT jsonb_array_elements_text(pol.p->'live_statuses')) AS live_status,
   jb.status::text IN (SELECT jsonb_array_elements_text(pol.p->'quote_statuses')) AS quote_status
  FROM public.jobs jb CROSS JOIN pol
  WHERE coalesce(jb.metadata->>'do_not_schedule','') NOT IN ('true','1')
 ),
 m4 AS (
  -- M4's list, exactly: a status on the live allow-list, or draft or quoted
  -- with a quote document sent in the last 60 days; never an archived flag.
  SELECT j.* FROM j WHERE NOT j.archived AND (j.live_status OR (j.quote_status AND j.quote_sent_at IS NOT NULL))
 ),
 mon AS (
  -- Every other job the lead rule keeps monitored (owner, 7 Oct 2026).
  SELECT j.* FROM j
  JOIN public.context_history_monitored_jobs(now(),
   ARRAY(SELECT j2.id FROM j j2 WHERE j2.live AND NOT EXISTS (SELECT 1 FROM m4 WHERE m4.id=j2.id))) h
   ON h.job_id=j.id AND h.monitored
 )
 SELECT m4.id, m4.job_number, m4.contact, m4.status,
  CASE WHEN m4.live_status THEN 'status' ELSE 'quote_sent' END,
  CASE WHEN NOT m4.live_status THEN 4
   WHEN m4.status IN (SELECT jsonb_array_elements_text(pol.p->'tier_1')) THEN 1
   WHEN m4.status IN (SELECT jsonb_array_elements_text(pol.p->'tier_2')) THEN 2 ELSE 3 END,
  greatest(m4.created_at,m4.updated_at,m4.quote_sent_at)
 FROM m4 CROSS JOIN pol
 UNION ALL
 SELECT mon.id, mon.job_number, mon.contact, mon.status,
  CASE WHEN mon.quote_status THEN 'lead_monitored' ELSE 'status' END,
  CASE WHEN mon.quote_status THEN 4
   WHEN mon.status IN (SELECT jsonb_array_elements_text(pol.p->'tier_1')) THEN 1
   WHEN mon.status IN (SELECT jsonb_array_elements_text(pol.p->'tier_2')) THEN 2 ELSE 3 END,
  greatest(mon.created_at,mon.updated_at,
   (SELECT max(d.sent_at) FROM public.job_documents d WHERE d.job_id=mon.id AND d.type='quote' AND d.sent_at<=now()))
 FROM mon CROSS JOIN pol
$$;
COMMENT ON FUNCTION public.context_ghl_history_live_jobs() IS
 'History daily (20261007050000), widening M4 (20260925031500): the CRM history load''s live jobs. Every row M4 gives, unchanged (captain ruling 24 Sep 2026: a status on the policy''s live allow-list, live_basis status, or draft or quoted with a quote document sent in the last 60 days, live_basis quote_sent; never an archived flag), plus every live job the lead rule keeps monitored (context_history_monitored_jobs, owner 7 Oct 2026): live_basis status for a status past quoted, lead_monitored for a quoted lead; tier as M4 (1 on site, 2 booked, 3 other work, 4 quotes). Never a holding job (metadata.do_not_schedule). ghl_contact_id null when the job has none. Read only.';

-- 4. The read for the scorecard v2: per monitored live job, its CRM history.
CREATE OR REPLACE FUNCTION public.context_history_crm_jobs(p_job_ids uuid[] DEFAULT NULL)
RETURNS TABLE(job_id uuid, job_number text, status text, crm_state text, reason text, ghl_contact_id text, contact_history text,
 contact_completed_at timestamptz, link_verdict text, link_reason text, link_tried_at timestamptz, in_load_scope boolean, lead_rule text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 WITH pol AS (SELECT public.context_history_daily_policy() AS p),
 mon AS (SELECT m.job_id, m.job_number, m.status, m.rule FROM public.context_history_monitored_jobs(now(), p_job_ids) m WHERE m.monitored),
 scope AS (SELECT DISTINCT l.job_id FROM public.context_ghl_history_live_jobs() l WHERE l.job_id IN (SELECT mon.job_id FROM mon)),
 j AS (
  SELECT mon.*, nullif(btrim(jb.ghl_contact_id), '') AS contact,
   coalesce(jb.metadata->>'do_not_schedule', '') IN ('true', '1') AS holding
  FROM mon JOIN public.jobs jb ON jb.id = mon.job_id
 ), k AS (
  SELECT j.*, j.contact ~ (pol.p->>'ghl_contact_id_pattern') AS valid_contact,
   h.status AS history, h.completed_at, a.verdict, a.reason AS a_reason, a.last_attempt_at,
   a.verdict IN (SELECT jsonb_array_elements_text(pol.p->'crm_tried_verdicts')) AS tried
  FROM j CROSS JOIN pol
  LEFT JOIN public.context_ghl_history_contacts h ON h.contact_id = j.contact
  LEFT JOIN public.context_ghl_history_link_attempts a ON a.job_id = j.job_id
 )
 SELECT k.job_id, k.job_number, k.status,
  CASE WHEN k.contact IS NOT NULL AND k.valid_contact AND k.history = 'done' THEN 'loaded'
       WHEN k.contact IS NULL AND NOT k.holding AND coalesce(k.tried, false) THEN 'tried_no_contact'
       ELSE 'missing' END,
  CASE WHEN k.contact IS NOT NULL AND NOT k.valid_contact THEN 'invalid_contact_id'
       WHEN k.contact IS NOT NULL AND k.history = 'done' THEN 'contact_history_done'
       WHEN k.holding THEN 'holding_job'
       WHEN k.contact IS NOT NULL AND k.history = 'partial' THEN 'history_partial'
       WHEN k.contact IS NOT NULL AND k.history = 'failed' THEN 'history_failed'
       WHEN k.contact IS NOT NULL THEN 'history_not_started'
       WHEN coalesce(k.tried, false) THEN k.a_reason
       WHEN k.verdict = 'failed' THEN 'link_failed'
       ELSE 'link_not_tried' END,
  k.contact, k.history, k.completed_at, k.verdict, k.a_reason, k.last_attempt_at,
  EXISTS (SELECT 1 FROM scope s WHERE s.job_id = k.job_id), k.rule
 FROM k ORDER BY k.job_id
$$;
COMMENT ON FUNCTION public.context_history_crm_jobs(uuid[]) IS
 'History daily (20261007050000): for the scorecard v2, one row per monitored live job (context_history_monitored_jobs, of p_job_ids when given), in job id order. crm_state: loaded (the job''s GHL contact''s history is done: context_ghl_history_contacts status done, whatever job ids that row lists), tried_no_contact (no GHL contact and the link step tried it: verdict certain, ambiguous or none, B-2''s rule), or missing. reason: contact_history_done; the link try''s reason code (not_in_ghl, no_keys, own_records_several, ...); or why missing: history_not_started, history_partial, history_failed, invalid_contact_id (never loadable), link_not_tried, link_failed (retried the next Perth day), holding_job (a holding job is never linked or loaded; a live one is an anomaly). in_load_scope: the job is on context_ghl_history_live_jobs() (false only for a holding job). lead_rule: which lead rule decided. Read only; service role only.';

CREATE OR REPLACE FUNCTION public.context_history_crm_summary() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 WITH pol AS (SELECT public.context_history_daily_policy() AS p),
 live AS (SELECT count(*) AS n FROM public.jobs jb CROSS JOIN pol
          WHERE jb.status::text <> ALL (ARRAY(SELECT jsonb_array_elements_text(pol.p->'live_excluded_statuses')))),
 r AS (SELECT * FROM public.context_history_crm_jobs(NULL)),
 c AS (SELECT count(*) AS monitored,
   count(*) FILTER (WHERE r.crm_state = 'loaded') AS loaded,
   count(*) FILTER (WHERE r.crm_state = 'tried_no_contact') AS tried,
   count(*) FILTER (WHERE r.crm_state = 'missing') AS missing,
   count(*) FILTER (WHERE NOT r.in_load_scope) AS outside
  FROM r)
 SELECT jsonb_build_object(
  'version', (SELECT pol.p->>'version' FROM pol), 'as_of', now(),
  'lead_rule', coalesce((SELECT min(r.lead_rule) FROM r), (SELECT pol.p->>'lead_rule_inline' FROM pol)),
  'live_jobs', (SELECT n FROM live), 'monitored_jobs', c.monitored, 'not_monitored_jobs', (SELECT n FROM live) - c.monitored,
  'loaded', c.loaded, 'tried_no_contact', c.tried, 'missing', c.missing, 'done', c.loaded + c.tried,
  'done_pct', CASE WHEN c.monitored = 0 THEN NULL ELSE round(100.0 * (c.loaded + c.tried) / c.monitored, 1) END,
  'missing_by_reason', coalesce((SELECT jsonb_object_agg(x.reason, x.n) FROM (
    SELECT r.reason, count(*) AS n FROM r WHERE r.crm_state = 'missing' GROUP BY r.reason) x), '{}'::jsonb),
  'tried_by_reason', coalesce((SELECT jsonb_object_agg(x.reason, x.n) FROM (
    SELECT r.reason, count(*) AS n FROM r WHERE r.crm_state = 'tried_no_contact' GROUP BY r.reason) x), '{}'::jsonb),
  'monitored_outside_load_scope', c.outside,
  'load_scope_jobs', (SELECT count(DISTINCT l.job_id) FROM public.context_ghl_history_live_jobs() l))
 FROM c
$$;
COMMENT ON FUNCTION public.context_history_crm_summary() IS
 'History daily (20261007050000): context_history_crm_jobs() in one object for the scorecard v2: live_jobs, monitored_jobs, not_monitored_jobs, loaded, tried_no_contact, missing, done (loaded plus tried), done_pct (of monitored), missing_by_reason, tried_by_reason, monitored_outside_load_scope (holding jobs), load_scope_jobs (context_ghl_history_live_jobs, the 24 Sep quotes included) and the lead rule that decided. Read only; service role only.';

-- 5. The daily Xero top-up. One run row a day, written through
-- record_capture_run: succeeded when nothing is left missing, partial while
-- rows are (a batch limit reached, or rows the writer refused, error code
-- xero_history_write_errors), failed when the writer itself failed (nothing
-- kept). The cursor names the keys this run wrote, so one run can be undone.
CREATE OR REPLACE FUNCTION public.trigger_xero_history_daily(p_limit integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
 pol jsonb := public.context_history_daily_policy();
 v_limit integer := coalesce(p_limit, (pol->>'xero_batch_limit')::integer);
 v_src text := pol->>'xero_run_source';
 v_started timestamptz := clock_timestamp();
 v_before text[]; v_after text[]; v_written text[]; v_jobs integer; v_raised integer; v_authorised integer; v_paid integer;
 v_res jsonb; v_run uuid; v_status text; v_code text; v_ins integer; v_dup integer; v_err integer; v_counts jsonb;
BEGIN
 IF v_limit IS NULL OR v_limit NOT BETWEEN 1 AND 5000 THEN
  RAISE EXCEPTION 'xero_history_daily_limit_invalid: limit must be 1 to 5000';
 END IF;
 -- The cron command is gated on the capture lane too; a hand call is idle the same way.
 IF NOT public.automation_lane_enabled('capture') THEN
  RETURN jsonb_build_object('outcome', 'capture_off', 'as_of', now());
 END IF;
 IF NOT pg_try_advisory_xact_lock(20261007, 50) THEN
  RETURN jsonb_build_object('outcome', 'busy', 'as_of', now());
 END IF;
 SELECT coalesce(array_agg(p.provider_message_id ORDER BY p.provider_message_id COLLATE "C"), '{}'::text[]),
  count(DISTINCT p.job_id)::integer, count(*) FILTER (WHERE p.kind = 'raised')::integer,
  count(*) FILTER (WHERE p.kind = 'authorised')::integer, count(*) FILTER (WHERE p.kind = 'paid')::integer
 INTO v_before, v_jobs, v_raised, v_authorised, v_paid
 FROM public.context_xero_evidence_backfill_plan() p;
 v_run := (public.record_capture_run(jsonb_build_object('source', v_src, 'status', 'running', 'window_to', v_started,
  'cursor', jsonb_build_object('v', 1, 'actor', pol->>'xero_actor', 'limit', v_limit),
  'counts', jsonb_build_object('missing_before', cardinality(v_before))))->>'run_id')::uuid;
 BEGIN
  v_res := public.context_xero_evidence_backfill(false, v_limit);
 EXCEPTION WHEN OTHERS THEN
  v_code := 'xero_history_daily_failed:' || lower(SQLSTATE);
  RAISE WARNING 'xero_history_daily_failed: SQLSTATE %', SQLSTATE;
  PERFORM public.record_capture_run(jsonb_build_object('run_id', v_run, 'source', v_src, 'status', 'failed', 'error_code', v_code,
   'counts', jsonb_build_object('missing_before', cardinality(v_before), 'inserted', 0, 'limit', v_limit),
   'cursor', jsonb_build_object('v', 1, 'actor', pol->>'xero_actor', 'limit', v_limit, 'written_keys', '[]'::jsonb)));
  RETURN jsonb_build_object('outcome', 'failed', 'run_id', v_run, 'status', 'failed', 'error_code', v_code);
 END;
 SELECT coalesce(array_agg(p.provider_message_id ORDER BY p.provider_message_id COLLATE "C"), '{}'::text[])
 INTO v_after FROM public.context_xero_evidence_backfill_plan() p;
 -- The keys this run wrote: missing before it, gone from the plan now, and
 -- carried by a Xero history writer's row. The writer holds its advisory lock
 -- to the end of this transaction, so no other history run wrote between the
 -- two reads; a row xero-sync wrote meanwhile has another source. (Never a
 -- capture time: a row's capture time is its transaction's start.)
 v_written := ARRAY(SELECT k FROM unnest(v_before) AS k
  WHERE NOT (k = ANY (v_after))
   AND EXISTS (SELECT 1 FROM public.business_events b WHERE b.provider_message_id = k AND b.source = 'xero-history')
  ORDER BY k COLLATE "C");
 v_ins := coalesce((v_res->'written'->>'inserted')::integer, 0);
 v_dup := coalesce((v_res->'written'->>'duplicate')::integer, 0);
 v_err := coalesce((v_res->'written'->>'errors')::integer, 0);
 v_status := CASE WHEN cardinality(v_after) > 0 THEN 'partial' ELSE 'succeeded' END;
 v_code := CASE WHEN v_err > 0 THEN 'xero_history_write_errors' END;
 v_counts := jsonb_build_object('missing_before', cardinality(v_before), 'missing_after', cardinality(v_after), 'jobs', v_jobs,
  'raised', v_raised, 'authorised', v_authorised, 'paid', v_paid, 'inserted', v_ins, 'duplicate', v_dup, 'errors', v_err,
  'written_keys', cardinality(v_written), 'more', CASE WHEN cardinality(v_after) > 0 THEN 1 ELSE 0 END, 'limit', v_limit);
 PERFORM public.record_capture_run(jsonb_build_object('run_id', v_run, 'source', v_src, 'status', v_status, 'error_code', v_code,
  'counts', v_counts,
  'cursor', jsonb_build_object('v', 1, 'actor', pol->>'xero_actor', 'limit', v_limit, 'written_keys', to_jsonb(v_written))));
 RETURN jsonb_build_object('outcome', 'ran', 'run_id', v_run, 'status', v_status, 'error_code', v_code, 'counts', v_counts);
END $fn$;
COMMENT ON FUNCTION public.trigger_xero_history_daily(integer) IS
 'History daily (20261007050000): pg_cron xero-history-daily (19:30 UTC, 03:30 Perth, capture lane): writes the Xero evidence rows still missing for live jobs'' sales invoices (context_xero_evidence_backfill(false, p_limit or 500): raised, authorised and paid, source xero-history, capture_mode backfill, idempotent by key) and records one run row xero_history_daily through record_capture_run: succeeded when nothing is left missing, partial while rows are (error_code xero_history_write_errors when the writer refused some), failed (error_code xero_history_daily_failed:<sqlstate>, nothing written) when the writer failed. counts: missing_before, missing_after, jobs, raised, authorised, paid, inserted, duplicate, errors, written_keys, more, limit; cursor.written_keys: the keys this run wrote. Requests no read. Outcomes: ran, capture_off (no run row), busy (another run holds the lock). Callable by the cron owner only.';

-- 6. The top-up's state for the scorecard v2.
CREATE OR REPLACE FUNCTION public.context_history_xero_daily_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
 pol jsonb := public.context_history_daily_policy();
 v_cron boolean := to_regclass('cron.job') IS NOT NULL;
 v_active boolean; v_schedule text; v_command text; r record; v_found boolean; v_plan jsonb; v_runs integer;
BEGIN
 IF v_cron THEN
  -- pg_cron row security can hide another role's job; this reads as the function owner.
  EXECUTE 'SELECT bool_or(active), min(schedule), min(command) FROM cron.job WHERE jobname = $1'
  INTO v_active, v_schedule, v_command USING pol->>'xero_cron_jobname';
 END IF;
 SELECT c.id, c.status, c.started_at, c.finished_at, c.error_code, c.counts INTO r
 FROM public.context_capture_runs c WHERE c.source = pol->>'xero_run_source' ORDER BY c.started_at DESC, c.id LIMIT 1;
 v_found := FOUND;
 SELECT count(*)::integer INTO v_runs FROM public.context_capture_runs c
 WHERE c.source = pol->>'xero_run_source' AND c.started_at > now() - interval '7 days';
 SELECT jsonb_build_object('missing_rows', count(*), 'missing_jobs', count(DISTINCT p.job_id), 'missing_invoices', count(DISTINCT p.invoice_id),
  'missing_by_kind', jsonb_build_object('raised', count(*) FILTER (WHERE p.kind = 'raised'),
   'authorised', count(*) FILTER (WHERE p.kind = 'authorised'), 'paid', count(*) FILTER (WHERE p.kind = 'paid')))
 INTO v_plan FROM public.context_xero_evidence_backfill_plan() p;
 RETURN jsonb_build_object('version', pol->>'version', 'as_of', now(),
  'cron_jobname', pol->>'xero_cron_jobname', 'cron_schedule_expected', pol->>'xero_cron_schedule',
  'cron_present', CASE WHEN v_cron THEN v_active IS NOT NULL END,
  'cron_active', CASE WHEN v_cron THEN coalesce(v_active, false) END,
  'cron_schedule', v_schedule,
  'cron_command_matches', CASE WHEN v_command IS NOT NULL THEN v_command = pol->>'xero_cron_command' END,
  'run_source', pol->>'xero_run_source',
  'last_run', CASE WHEN v_found THEN jsonb_build_object('run_id', r.id, 'status', r.status, 'started_at', r.started_at,
   'finished_at', r.finished_at, 'error_code', r.error_code, 'counts', r.counts) END,
  'runs_last_7_days', v_runs,
  'plan', v_plan);
END $fn$;
COMMENT ON FUNCTION public.context_history_xero_daily_status() IS
 'History daily (20261007050000): the daily Xero top-up for the scorecard v2: its cron job (cron_present, cron_active, cron_schedule, cron_command_matches; null when pg_cron is absent), the newest xero_history_daily run (status, times, error code, counts), runs in the last 7 days, and what context_xero_evidence_backfill_plan() still lists missing (rows, jobs, invoices, by kind). Read only; service role only.';

-- 7. The capture lane owns the new job. The 20261005210000 body plus one row,
-- unless the live list already names it.
DO $lanes$
DECLARE live text;
BEGIN
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = 'public.automation_switch_cron_lanes()'::regprocedure;
 IF live = '99e6d70e80a79e548f2478b65fc6cd78' OR live = '81cbebf914f537b0b85870196cbd0f75' THEN
  EXECUTE $def$
CREATE OR REPLACE FUNCTION public.automation_switch_cron_lanes()
RETURNS TABLE (cron_jobname text, lane text)
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT * FROM (VALUES
    -- capture: pollers that write evidence rows into business_events
    ('monitor-inbox-poll', 'capture'),
    ('ghl-message-reconcile', 'capture'),
    ('ghl-call-transcript-fetch', 'capture'),
    ('outlook-mail-poll', 'capture'),
    ('monitor-inbox-sweep', 'capture'),
    ('ghl-history-schedule', 'capture'),
    ('context-document-text', 'capture'),
    ('xero-history-daily', 'capture'),
    -- attribution: the contact match the ladder resolves a job through
    ('contact-matching',   'attribution')
  ) AS t(cron_jobname, lane);
$fn$
$def$;
 ELSE
  RAISE NOTICE 'history daily: automation_switch_cron_lanes() already names xero-history-daily; left alone';
 END IF;
END $lanes$;

-- Scheduled already gated, so the switch's wrap reports already_wrapped and its
-- unwrap can remove the suffix. Skipped where pg_cron is absent (contract runner).
DO $cron$
BEGIN
 IF to_regclass('cron.job') IS NULL THEN
  RAISE NOTICE 'history daily: pg_cron absent, xero-history-daily not scheduled';
  RETURN;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'xero-history-daily') THEN
  PERFORM cron.schedule('xero-history-daily', '30 19 * * *',
   $cmd$SELECT public.trigger_xero_history_daily() WHERE public.automation_lane_enabled('capture')$cmd$);
 END IF;
END $cron$;

-- 8. Grants. Service side only; the cron caller by the cron owner only.
REVOKE ALL ON FUNCTION public.context_history_daily_policy(), public.context_history_monitored_jobs(timestamptz, uuid[]),
 public.context_ghl_history_live_jobs(), public.context_history_crm_jobs(uuid[]), public.context_history_crm_summary(),
 public.trigger_xero_history_daily(integer), public.context_history_xero_daily_status()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_history_daily_policy(), public.context_history_monitored_jobs(timestamptz, uuid[]),
 public.context_ghl_history_live_jobs(), public.context_history_crm_jobs(uuid[]), public.context_history_crm_summary(),
 public.context_history_xero_daily_status()
TO service_role;
REVOKE ALL ON FUNCTION public.trigger_xero_history_daily(integer) FROM service_role;
GRANT EXECUTE ON FUNCTION public.trigger_xero_history_daily(integer) TO postgres;
REVOKE ALL ON FUNCTION public.automation_switch_cron_lanes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.automation_switch_cron_lanes() TO service_role, postgres;
