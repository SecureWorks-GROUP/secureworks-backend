-- Context scorecard v2: the owner's definition of done, rows 1 to 14, wired to
-- every data source the 7 Oct 2026 builders added, and measured on the new AI
-- reader (the job ledger), on the live jobs the lead rule keeps monitored.
--
-- The owner's rulings this follows (7 Oct 2026):
--  - everything runs on the new AI reader (the job ledger, context_ledger_*);
--    the old fact reader is retired, so no row reads it any more;
--  - done means all 14 rows green and live;
--  - a lead with no progress stops being monitored 28 days after the newer of
--    its newest quote send and the customer's newest inbound message (the
--    lead rule, context_lead_monitored_jobs, 20261007010000);
--  - nothing messages a customer or staff, moves money or changes a job status
--    without his yes. This migration writes nothing at all.
--
-- What changes, row by row (each lane keeps the scorecard's lane shape:
-- row, lane, number, unit, green, amber, higher_is_better, status, value, note):
--  Scope. Every job-scoped row reads the monitored live jobs:
--   context_lead_monitored_jobs(NULL, as_of) WHERE monitored. The card carries
--   live_jobs (every live job), monitored_jobs and leads_not_followed_up.
--  Row 1. Unchanged.
--  Row 2. The five message lanes read the stored stamps through the v4
--   classifier's read (context_party_roles_lanes, 20261007060000): the same
--   counts as before, with how many stamps are older than the live classifier.
--   The crew and staff lane is unchanged.
--  Row 3. customer_facing leaves out the messages from prospects and leads with
--   no job yet that sit on no job (context_party_roles_lanes no_job_customers
--   minus no_job_customers_on_a_job): no job exists to place them on. The value
--   keeps its "<on a job> of <customers> ..." form (the v4 re-stamp script
--   compares it). known_misfiles counts every known misfile
--   (context_placement_misfile_counts, 20261007070000): rows whose own payload
--   names another job, plus every row on a holding job, which is never a
--   customer's job. right_job_accuracy is two lanes, one per population of the
--   placement grade (context_placement_grades_newest): right_job_customer_facing
--   and right_job_xero_and_quotes, each green only on a whole graded sample of
--   at least 100 items whose right_of_all is at least 95%.
--  Row 4. ghl_history reads the CRM history read (context_history_crm_summary,
--   20261007050000): done is loaded plus tried with no CRM contact (desk
--   decision B-2), of the monitored live jobs. history_schedules names the
--   daily Xero top-up's cron job (xero-history-daily), and xero_history notes
--   the top-up's last run and what it still lists missing.
--  Row 5. Unchanged.
--  Row 6. Measured by the AI reader: an item (context_ledger_evidence_rows, not
--   a copy) is read when the job's live ledger reading has read it (its
--   evidence_until is at or after the item's landed_at); live items late past
--   2 hours, the unread backlog (red past 24 hours), and the ledger reader's
--   failed runs today. A shadow reading is never read here (named in the note).
--  Row 7. The published catalogue of ledger item kinds (context_item_kinds,
--   20261007090000) and the newest ledger grade (context_grades_newest): at
--   least 95% of items pass on at least 10 jobs, no unsafe item, every gated
--   item graded on a reading that is live. The old fact coverage lane is gone.
--  Row 8. The newest story grade: every bar of the story grade on at least 10
--   jobs, graded on live readings. The brief lane is gone (the brief is not
--   part of the job answer any more).
--  Row 9. The newest agent grade: 30 baseline answers all correct on at least
--   10 jobs with the story switch on, live readings and no unsafe line; 9+ the
--   story calls all pass.
--  Row 10. hourly_run is context_scorecard_run_status(as_of)->'lane'
--   (20261007040000), as it is.
--  Rows 11 to 13. Unchanged rules, on the monitored live jobs; the live ledger
--   reading is the one live at as_of.
--  Row 14. Unchanged lanes on the monitored live jobs, plus email_reach: the
--   share of monitored live jobs whose email history is loaded back to their
--   start (context_email_history_reach, 20261007080000).
--
-- Every share is rounded down to 0.1, never up, so no lane reads green by
-- rounding; a failure share (lower is better) is rounded up. Every threshold
-- is in context_scorecard_policy(). A lane SQL cannot measure stays red with the
-- reason. p_as_of cuts the evidence as in v1; the CRM history read and the
-- grades' reading status read the database as it is now (each says so).
--
-- context_scorecard_jobs pages over the monitored live jobs in id order and
-- grades rows 2, 4, 6, 11, 12, 13 and 14 for each; rows 7, 8 and 9 appear on
-- a job only when the newest sample of that grade graded it.
--
-- Both reads carry SET statement_timeout = '50s': PostgREST applies a
-- function's statement_timeout to the call (hoisted settings), so the staff
-- door (ops-api, whose role stops a statement at 8 s) can wait for the card,
-- which reads the lead rule, the CRM read, the email reach and the ledger's
-- evidence of every monitored job. The hourly job's own 60 s timer is unchanged.
-- The staff door (ops-api context_scorecard_read.ts) accepts the v1 and the v2
-- card and page, so this migration and its rollback both answer it.
--
-- Contracts touched: W11's (20261006032000) stands its three bodies back up
-- inside each of its rolled-back transactions while a later body is live
-- (w11_scorecard.sql, word for word), and the hourly run's (20261007040000)
-- rollback proof does the same, since that rollback refuses while the card
-- reads context_scorecard_run_status.
--
-- Replaced (the guard refuses unless each is the live body or already this
-- migration's; md5 of prosrc, read from production read only on 8 Oct 2026):
--   context_scorecard_policy()                         50ed8ccdac924097399359a9857f02a8 (W11, 20261006032000)
--   context_scorecard(timestamptz)                     82574dfb65328d855ad87683a78ca9cd (W11)
--   context_scorecard_jobs(uuid,integer,timestamptz)   6fd07f87b10ff8e0164f2daad98cce48 (W11)
-- Read, never replaced: context_scorecard_lane_of (20261006034000's body),
-- every v1 read, the lead rule, the hourly run status, the CRM history read and
-- the Xero top-up status, the party roles read, the placement grades and
-- misfile counts, the email reach reads, the item kinds and grades, and the
-- ledger's evidence, checks and failures. Signatures, grants and the service
-- role only access stay.
--
-- Rollback: supabase/rollbacks/20261007120000_context_scorecard_v2_down.sql
-- (W11's three bodies and comments, word for word; it refuses unless the live
-- bodies are this migration's).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Pre-image guard. Reports every problem at once.
DO $guard$
DECLARE problems text[] := '{}'; x record; live text; f text;
BEGIN
 -- Replaced: W11's live body, or this migration's (a re-apply).
 FOR x IN SELECT * FROM (VALUES
  ('public.context_scorecard_policy()', ARRAY['50ed8ccdac924097399359a9857f02a8', 'c878868c9d3779a6d3721b04211b8451']),
  ('public.context_scorecard(timestamptz)', ARRAY['82574dfb65328d855ad87683a78ca9cd', 'c77af743de0e05f3c39b3a803ce3d6d3']),
  ('public.context_scorecard_jobs(uuid,integer,timestamptz)', ARRAY['6fd07f87b10ff8e0164f2daad98cce48', 'c0a2b2a18dfa2f6bc78f883911896d87'])
 ) AS t(sig, accepted) LOOP
  live := NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS NULL OR NOT live = ANY (x.accepted) THEN
   problems := problems || format('%s md5 %s', x.sig, coalesce(live, '<missing>'));
  END IF;
 END LOOP;
 -- The data sources, each the slice that owns it (its comment says so).
 FOR x IN SELECT * FROM (VALUES
  ('public.context_lead_monitored_jobs(uuid[],timestamptz)', 'Lead cutoff (20261007010000)%'),
  ('public.context_scorecard_run_status(timestamptz)', 'Context scorecard hourly (20261007040000)%'),
  ('public.context_history_crm_summary()', 'History daily (20261007050000)%'),
  ('public.context_history_crm_jobs(uuid[])', 'History daily (20261007050000)%'),
  ('public.context_history_xero_daily_status()', 'History daily (20261007050000)%'),
  ('public.context_party_roles_lanes(timestamptz,integer)', 'Party roles v4 (20261007060000)%'),
  ('public.context_placement_grades_newest(timestamptz,text)', 'Context placement grades (20261007070000)%'),
  ('public.context_placement_misfile_counts(timestamptz)', 'Context placement grades (20261007070000)%'),
  ('public.context_email_history_reach(timestamptz)', 'History depth (20261007080000)%'),
  ('public.context_email_history_reach_jobs(uuid[],timestamptz)', 'History depth (20261007080000)%'),
  ('public.context_item_kinds()', 'Context grades (20261007090000)%'),
  ('public.context_grades_newest(timestamptz)', 'Context grades (20261007090000)%'),
  ('public.context_grade_passed(text,text,jsonb)', 'Context grades (20261007090000)%')
 ) AS t(sig, note) LOOP
  IF to_regprocedure(x.sig) IS NULL THEN
   problems := problems || format('%s is missing', x.sig);
  ELSIF coalesce(obj_description(to_regprocedure(x.sig), 'pg_proc'), '') NOT LIKE x.note THEN
   problems := problems || format('%s is not the slice''s own (comment does not start %s)', x.sig, rtrim(x.note, '%'));
  END IF;
 END LOOP;
 -- Read as before (W11), or for rows 6, 11 and 12.
 FOREACH f IN ARRAY ARRAY['public.context_scorecard_lane_of(text,text,text,text,text,jsonb)',
   'public.context_source_freshness()','public.context_email_capture_status()','public.context_ghl_capture_status()',
   'public.context_transcript_capture_status()','public.context_document_text_status()','public.context_document_vision_status()',
   'public.context_ghl_history_progress()','public.context_email_history_status()','public.context_payload_job_mismatch_rows()',
   'public.context_business_minutes(timestamptz,timestamptz)','public.context_job_record_timeline(uuid[],timestamptz)',
   'public.context_job_record_loops(uuid[],timestamptz)','public.context_ledger_evidence_rows(uuid[],timestamptz)',
   'public.context_ledger_checks_pass(jsonb)','public.context_ledger_failures(uuid[])',
   'public.context_client_story(uuid,timestamptz)'] LOOP
  IF to_regprocedure(f) IS NULL THEN problems := problems || format('%s is missing', f); END IF;
 END LOOP;
 FOR x IN SELECT * FROM (VALUES
  ('jobs','status'),('jobs','job_number'),('jobs','created_at'),('jobs','ghl_contact_id'),('jobs','client_email'),
  ('business_events','job_id'),('business_events','metadata'),('business_events','context_captured_at'),('business_events','recorded_at'),
  ('business_events','candidate_job_ids'),('business_events','attribution_status'),
  ('context_ledger_generations','job_id'),('context_ledger_generations','status'),('context_ledger_generations','promoted_at'),
  ('context_ledger_generations','retired_at'),('context_ledger_generations','evidence_until'),('context_ledger_generations','checks'),
  ('context_ledger_items','generation_id'),('context_ledger_items','item_type'),
  ('context_extraction_runs','phase'),('context_extraction_runs','status'),('context_extraction_runs','run_date'),
  ('context_extraction_runs','started_at'),('context_extraction_runs','error'),
  ('context_grades','kind'),('context_grades','sample_id'),('context_grades','job_id'),('context_grades','unit'),
  ('context_grades','verdicts'),('context_grades','gated'),
  ('context_capture_runs','source'),('context_email_history_plan','window_from'),('xero_invoices','job_id'),('feature_flags','flag_name')
 ) AS c(tbl, col) LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.' || x.tbl) AND a.attname = x.col
                 AND a.attnum > 0 AND NOT a.attisdropped) THEN
   problems := problems || format('public.%s.%s is missing', x.tbl, x.col);
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_scorecard_v2_preimage_mismatch: %; read the live definitions before replacing them', array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. Every threshold. To change one, change it here (by migration) and say why.
CREATE OR REPLACE FUNCTION public.context_scorecard_policy()
RETURNS jsonb
LANGUAGE sql IMMUTABLE
AS $fn$
 SELECT jsonb_build_object(
  'version', 'context-scorecard-v2',
  -- A job is live unless its status is one of these (done definition, 5 Oct).
  'live_excluded_statuses', jsonb_build_array('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost'),
  -- Which live jobs the job rows measure (owner, 7 Oct 2026): the ones the lead
  -- rule keeps monitored. A lead with no progress stops being monitored 28 days
  -- after the newer of its newest quote send and the customer's newest inbound
  -- message; it is monitored again the moment it progresses or the customer writes.
  'scope', jsonb_build_object('rule', 'context_lead_monitored_jobs', 'lead_cutoff_days', 28),
  -- Event lanes (rows 1, 2, 3) look back this many days from as_of.
  'window_days', 30,
  -- Row 1 and the lane_quiet alarm (unchanged from v1; Perth working minutes).
  'lane_quiet', jsonb_build_object(
   'texts',            jsonb_build_object('label', 'texts', 'ord', 1,  'warn_after', 60,  'alarm_after', 120),
   'calls',            jsonb_build_object('label', 'calls', 'ord', 2,  'warn_after', 60,  'alarm_after', 120),
   'call_transcripts', jsonb_build_object('label', 'call transcripts', 'ord', 3,  'warn_after', 90,  'alarm_after', 180),
   'emails_in',        jsonb_build_object('label', 'incoming emails', 'ord', 4,  'warn_after', 30,  'alarm_after', 60),
   'emails_out',       jsonb_build_object('label', 'outgoing emails', 'ord', 5,  'warn_after', 60,  'alarm_after', 120),
   'xero',             jsonb_build_object('label', 'Xero invoices or payments', 'ord', 6,  'warn_after', 330, 'alarm_after', 660),
   'quotes',           jsonb_build_object('label', 'quotes', 'ord', 7,  'warn_after', 330, 'alarm_after', 660),
   'bookings',         jsonb_build_object('label', 'bookings or calendar items', 'ord', 8,  'warn_after', 660, 'alarm_after', 1320),
   'documents',        jsonb_build_object('label', 'documents', 'ord', 9,  'warn_after', 330, 'alarm_after', 660),
   'crew_staff_texts', jsonb_build_object('label', 'crew or staff texts', 'ord', 10, 'warn_after', 660, 'alarm_after', 1320)),
  -- Row 4 and the history_load_stalled alarm (unchanged).
  'history_stall_runs', 3,
  'history_progress_keys', jsonb_build_array('inserted', 'upgraded', 'contacts_done', 'linked', 'attempts_recorded'),
  -- Row 4: the cron job that keeps each history load running daily; the daily
  -- Xero top-up is xero-history-daily (20261007050000).
  'history_schedules', jsonb_build_object('ghl', 'ghl-history-schedule', 'email', 'outlook-mail-poll', 'xero', 'xero-history-daily'),
  -- Row 2.
  'who_to_whom', jsonb_build_object('green_pct', 95, 'amber_pct', 80),
  'crew_rule_since', '2026-10-04T22:31:00Z',
  -- Row 3: placed share (an upper bound on the right job).
  'placement', jsonb_build_object('green_pct', 95, 'amber_pct', 80),
  -- Row 3: the graded share on the right job, per population: a whole graded
  -- sample (graded = drawn) of at least min_drawn items, and right_of_all (the
  -- estimated share of ALL the population's items on the right job) at least
  -- green_pct.
  'right_job', jsonb_build_object('populations', jsonb_build_array('customer_facing', 'xero_and_quotes'),
   'min_drawn', 100, 'green_pct', 95, 'amber_pct', 80),
  'review_queue', jsonb_build_object('green_pct', 95, 'amber_pct', 50),
  -- Row 4: done is loaded or tried with no CRM contact (desk decision B-2).
  'history', jsonb_build_object('green_pct', 95, 'amber_pct', 50, 'crm_done_states', jsonb_build_array('loaded', 'tried_no_contact'),
   'crm_lead_rule', 'context_lead_monitored_jobs'),
  -- Row 5.
  'documents', jsonb_build_object('green_pct', 95, 'amber_pct', 70),
  -- Row 6, on the AI reader (the job ledger): a live-captured item must be read
  -- by the job's live reading within live_max_minutes of landing; a backfill or
  -- relinked item unread longer than backlog_max_hours turns the backlog red
  -- ("0 each morning"); the ledger runs that failed today above
  -- failed_amber_pct turn red.
  'reading', jsonb_build_object('reader', 'context_ledger', 'run_phase', 'ledger', 'live_max_minutes', 120,
   'backlog_max_hours', 24, 'failed_amber_pct', 10),
  -- Row 7: the ledger grade (done definition: at least 95% on a 10-job sample).
  -- The T5 split is reported, not gated.
  'facts', jsonb_build_object('grade_kind', 'ledger', 'min_jobs', 10, 'green_pct', 95, 'max_unsafe_lines', 0,
   'split', jsonb_build_object('verbatim', 100, 'parties', 97, 'supported', 95)),
  -- Row 8: the story grade's bars (GRADE-PLAN section 7).
  'answer', jsonb_build_object('grade_kind', 'story', 'min_jobs', 10, 'recall_message_pct', 95, 'precision_pct', 90,
   'unseen_first_line_pct', 90, 'max_unsafe_lines', 0,
   'card_tests', jsonb_build_array('timeline', 'record_loops', 'money', 'dates', 'honesty')),
  -- Row 9 and 9+: the agent test (T7). A call that answered without a story
  -- tool is listed, not gated (GRADE-PLAN part C), and the ledger mode at the
  -- run is reported, not gated (the readings must be live).
  'agent', jsonb_build_object('grade_kind', 'agent', 'min_jobs', 10, 'baseline_calls', 30, 'story_calls', 10,
   'max_unsafe_lines', 0, 'story_flag_required', true, 'story_tool_missed_gates', false, 'ledger_mode_live_gates', false),
  -- Rows 11 to 13.
  'story', jsonb_build_object('green_pct', 95, 'amber_pct', 50, 'timeline_min_rows', 2),
  -- Row 14.
  'depth', jsonb_build_object('start_days', 7, 'green_pct', 95, 'amber_pct', 80),
  -- Row 10.
  'hourly', jsonb_build_object('surface', 'context_scorecard_run_status')
 )
$fn$;
COMMENT ON FUNCTION public.context_scorecard_policy() IS
 'Context scorecard v2 (20261007120000): every threshold the scorecard grades against, in one place: the scope (the live jobs the lead rule keeps monitored, owner 7 Oct 2026), lane quiet minutes in Perth working time, every percentage, the history stall rule and the cron jobs that keep history loads daily (xero-history-daily for Xero), the right-job grade (a whole sample of at least 100, right_of_all at least 95%), the reading rule on the AI reader (2 hours live, 24 hours backlog), and the bars of the ledger, story and agent grades. Changed only by migration.';

-- 2. The scorecard: rows 1 to 14, per lane, and the alarms.
CREATE OR REPLACE FUNCTION public.context_scorecard(p_as_of timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET statement_timeout = '50s'
AS $fn$
DECLARE
 v_pol jsonb := public.context_scorecard_policy();
 v_as_of timestamptz := coalesce(p_as_of, now());
 v_from timestamptz;
 v_mon uuid[];                    -- the monitored live jobs (the lead rule), in id order
 v_mon_n integer;
 v_live_n integer;                -- every live job (the done definition's list)
 v_off_n integer;                 -- live leads the lead rule no longer follows up
 v_lanes jsonb := '[]'::jsonb;    -- one object per lane; statuses are graded at the end
 v_alarms jsonb := '[]'::jsonb;
 v_ev jsonb;                      -- per-lane aggregates over the window
 v_pr jsonb;                      -- row 2: the stamps per message lane (context_party_roles_lanes)
 v_q record; v_r record; v_x record; v_g record; v_pg record; v_k record;
 v_newest timestamptz; v_quiet integer; v_n numeric; v_d numeric; v_m numeric; v_txt text; v_status text;
 v_fresh jsonb; v_ecap jsonb; v_gcap jsonb; v_tcap jsonb; v_dt jsonb; v_vs jsonb; v_gh jsonb; v_eh jsonb;
 v_crm jsonb; v_xd jsonb; v_mis jsonb; v_reach jsonb; v_run jsonb;
 v_keys text; v_missing text[]; v_rows jsonb; v_why text[];
BEGIN
 v_from := v_as_of - make_interval(days => (v_pol->>'window_days')::integer);
 -- The scope: the live jobs the lead rule keeps monitored at the instant.
 SELECT coalesce(array_agg(m.job_id ORDER BY m.job_id) FILTER (WHERE m.monitored), '{}'::uuid[]), count(*)::integer,
        (count(*) FILTER (WHERE NOT m.monitored))::integer
 INTO v_mon, v_live_n, v_off_n
 FROM public.context_lead_monitored_jobs(NULL, v_as_of) m;
 v_mon_n := cardinality(v_mon);

 v_fresh := public.context_source_freshness();
 v_ecap := public.context_email_capture_status();
 v_gcap := public.context_ghl_capture_status();
 v_tcap := public.context_transcript_capture_status();
 v_dt := public.context_document_text_status();
 v_vs := public.context_document_vision_status();
 v_gh := public.context_ghl_history_progress();
 v_eh := public.context_email_history_status();

 -- One pass over the window: per lane, the newest live item, the crew rule and placement.
 SELECT coalesce(jsonb_object_agg(a.lane, to_jsonb(a) - 'lane'), '{}'::jsonb) INTO v_ev
 FROM (
  SELECT e.lane,
         max(e.cap) FILTER (WHERE e.live_mode) AS newest_live,
         count(*) FILTER (WHERE e.live_mode AND e.cap > v_as_of - interval '24 hours') AS live_24h,
         count(*) AS n,
         count(*) FILTER (WHERE e.job_id IS NOT NULL) AS placed,
         count(*) FILTER (WHERE e.pr->>'audience' = 'customer') AS customer,
         count(*) FILTER (WHERE e.pr->>'audience' = 'customer' AND e.job_id IS NOT NULL) AS customer_placed,
         count(*) FILTER (WHERE e.cap >= (v_pol->>'crew_rule_since')::timestamptz) AS since_rule,
         count(*) FILTER (WHERE e.cap >= (v_pol->>'crew_rule_since')::timestamptz AND e.job_id IS NULL) AS since_rule_off_job,
         count(*) FILTER (WHERE e.cap >= (v_pol->>'crew_rule_since')::timestamptz AND e.job_id IS NOT NULL
                            AND coalesce(e.md->>'audience', e.pr->>'audience', '') <> 'internal') AS since_rule_not_internal
  FROM (
   SELECT public.context_scorecard_lane_of(b.event_type, b.source, b.channel, b.direction, b.body_preview, b.metadata) AS lane,
          coalesce(b.context_captured_at, b.recorded_at) AS cap, b.job_id, b.metadata AS md, b.metadata->'party_roles' AS pr,
          coalesce(b.metadata->>'capture_mode', 'live') NOT IN ('backfill', 'relink') AS live_mode
   FROM public.business_events b
   WHERE coalesce(b.context_captured_at, b.recorded_at) > v_from AND coalesce(b.context_captured_at, b.recorded_at) <= v_as_of
  ) e
  WHERE e.lane IS NOT NULL
  GROUP BY e.lane
 ) a;
 -- The v4 classifier's read of the same window: stamps per message lane.
 SELECT coalesce(jsonb_object_agg(p.lane, to_jsonb(p) - 'lane'), '{}'::jsonb) INTO v_pr
 FROM public.context_party_roles_lanes(v_as_of, (v_pol->>'window_days')::integer) p;

 ---------------------------------------------------------------------------
 -- Row 1. Capture: every lane live, and an alarm when a lane goes quiet (unchanged).
 FOR v_r IN SELECT k.key AS lane, k.value AS cfg FROM jsonb_each(v_pol->'lane_quiet') k ORDER BY (k.value->>'ord')::integer LOOP
  v_newest := (v_ev->v_r.lane->>'newest_live')::timestamptz;
  v_quiet := CASE WHEN v_newest IS NULL THEN NULL ELSE public.context_business_minutes(v_newest, v_as_of) END;
  v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 1, 'lane', v_r.lane,
   'number', v_quiet, 'unit', 'working minutes since the newest live item',
   'green', (v_r.cfg->>'warn_after')::numeric, 'amber', (v_r.cfg->>'alarm_after')::numeric, 'higher_is_better', false,
   'value', CASE WHEN v_newest IS NULL THEN 'no live item in ' || (v_pol->>'window_days') || ' days'
                 ELSE v_quiet || ' working minutes quiet; ' || coalesce(v_ev->v_r.lane->>'live_24h', '0') || ' live items in 24 h' END,
   'note', 'alarm after ' || (v_r.cfg->>'alarm_after') || ' working minutes (Perth, Mon to Sat 07:00 to 18:00)'));
  IF v_quiet IS NULL OR v_quiet > (v_r.cfg->>'alarm_after')::integer THEN
   v_alarms := v_alarms || jsonb_build_array(jsonb_build_object('key', 'lane_quiet', 'row', 1, 'lane', v_r.lane,
    'since', v_newest, 'quiet_working_minutes', v_quiet, 'alarm_after', (v_r.cfg->>'alarm_after')::integer,
    'what_to_do', 'No new ' || (v_r.cfg->>'label') || ' have arrived for longer than the lane allows in working hours. Check the writer for this lane (its function, cron job or webhook), its provider login, and that the capture lane is on.'));
  END IF;
 END LOOP;
 SELECT count(*), string_agg(DISTINCT a.k, ', ' ORDER BY a.k) INTO v_n, v_keys
 FROM (SELECT ((x->>'key') || coalesce(':' || coalesce(x->>'source', x->>'line'), '')) COLLATE "C" AS k
       FROM jsonb_array_elements(coalesce(v_fresh->'alarms', '[]') || coalesce(v_ecap->'alarms', '[]')
                                  || coalesce(v_gcap->'alarms', '[]') || coalesce(v_tcap->'alarms', '[]')) x) a;
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 1, 'lane', 'capture_status_alarms',
  'number', v_n, 'unit', 'alarms raised by the capture status functions', 'green', 0, 'amber', NULL, 'higher_is_better', false,
  'status', CASE WHEN v_n = 0 THEN 'green' ELSE 'amber' END,
  'value', v_n || ' alarms' || coalesce(': ' || v_keys, ''),
  'note', 'context_source_freshness, context_email_capture_status, context_ghl_capture_status and context_transcript_capture_status; warnings, so amber'));
 SELECT coalesce(sum((l->>'erroring')::integer), 0), coalesce(sum((l->>'erroring')::integer) FILTER (WHERE NOT coalesce((l->>'personal')::boolean, false)), 0)
 INTO v_n, v_d FROM jsonb_array_elements(coalesce(v_ecap->'lines', '[]')) l;
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 1, 'lane', 'mailboxes_erroring',
  'number', v_n, 'unit', 'mailbox sources erroring', 'green', 0, 'amber', 0, 'higher_is_better', false,
  'value', v_n || ' erroring (' || v_d || ' business, ' || (v_n - v_d) || ' personal)', 'note', 'from context_email_capture_status'));

 ---------------------------------------------------------------------------
 -- Row 2. Who-to-whom: both roles on every message (the stored stamps, read
 -- through the v4 classifier's read); crew texts stay on their job, internal.
 FOR v_txt IN SELECT unnest(ARRAY['texts', 'calls', 'call_transcripts', 'emails_in', 'emails_out']) LOOP
  v_n := coalesce((v_pr->v_txt->>'messages')::numeric, 0);
  v_d := coalesce((v_pr->v_txt->>'both_known')::numeric, 0);
  v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 2, 'lane', v_txt,
   'number', CASE WHEN v_n = 0 THEN NULL ELSE trunc(100.0 * v_d / v_n, 1) END, 'unit', '% of messages naming both sides',
   'green', (v_pol->'who_to_whom'->>'green_pct')::numeric, 'amber', (v_pol->'who_to_whom'->>'amber_pct')::numeric, 'higher_is_better', true,
   'status', CASE WHEN v_n = 0 THEN 'green' END,
   'value', v_d || ' of ' || v_n || ' messages in ' || (v_pol->>'window_days') || ' days name both sides',
   'note', (v_n - coalesce((v_pr->v_txt->>'stamped')::numeric, 0)) || ' carry no party roles; '
           || coalesce(v_pr->v_txt->>'older_stamps', '0') || ' stamped before ' || coalesce(v_pr->v_txt->>'live_version', 'the live classifier')
           || ' (context_party_roles_lanes)'));
 END LOOP;
 v_n := coalesce((v_ev->'crew_staff_texts'->>'since_rule_off_job')::numeric, 0);
 v_d := coalesce((v_ev->'crew_staff_texts'->>'since_rule_not_internal')::numeric, 0);
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 2, 'lane', 'crew_staff_texts',
  'number', v_n + v_d, 'unit', 'crew or staff texts off their job or not labelled internal', 'green', 0, 'amber', 0, 'higher_is_better', false,
  'value', v_n || ' off their job, ' || v_d || ' on a job but not labelled internal, of '
           || coalesce(v_ev->'crew_staff_texts'->>'since_rule', '0') || ' since the internal-text rule',
  'note', 'counted from ' || (v_pol->>'crew_rule_since')));

 ---------------------------------------------------------------------------
 -- Row 3. Placement.
 SELECT coalesce(sum((v_ev->l->>'customer')::numeric), 0) AS cust, coalesce(sum((v_ev->l->>'customer_placed')::numeric), 0) AS cust_placed,
        coalesce(sum((v_ev->l->>'n')::numeric), 0) AS msgs, coalesce(sum((v_ev->l->>'placed')::numeric), 0) AS placed,
        coalesce(sum(greatest(coalesce((v_pr->l->>'no_job_customers')::numeric, 0)
                              - coalesce((v_pr->l->>'no_job_customers_on_a_job')::numeric, 0), 0)), 0) AS prospects
 INTO v_q FROM unnest(ARRAY['texts', 'calls', 'call_transcripts', 'emails_in', 'emails_out']) l;
 -- Prospects and leads with no job yet have no job to be placed on: left out of
 -- the customers (never more than the customer messages that are on no job).
 v_m := least(v_q.prospects, greatest(v_q.cust - v_q.cust_placed, 0));
 v_n := v_q.cust - v_m;
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 3, 'lane', 'customer_facing',
  'number', CASE WHEN v_n = 0 THEN NULL ELSE trunc(100.0 * v_q.cust_placed / v_n, 1) END,
  'unit', '% of customer messages on a job', 'green', (v_pol->'placement'->>'green_pct')::numeric,
  'amber', (v_pol->'placement'->>'amber_pct')::numeric, 'higher_is_better', true,
  'status', CASE WHEN v_n = 0 THEN 'green' END,
  'value', v_q.cust_placed || ' of ' || v_n || ' customer messages in ' || (v_pol->>'window_days') || ' days are on a job',
  'note', 'placed share, an upper bound on right-job accuracy; ' || v_m || ' messages from prospects or leads with no job yet left out '
          || '(context_party_roles_lanes); all messages: ' || v_q.placed || ' of ' || v_q.msgs || ' on a job'));
 v_n := coalesce((v_ev->'xero'->>'n')::numeric, 0) + coalesce((v_ev->'quotes'->>'n')::numeric, 0);
 v_d := coalesce((v_ev->'xero'->>'placed')::numeric, 0) + coalesce((v_ev->'quotes'->>'placed')::numeric, 0);
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 3, 'lane', 'xero_and_quotes',
  'number', CASE WHEN v_n = 0 THEN NULL ELSE trunc(100.0 * v_d / v_n, 1) END, 'unit', '% of Xero and quote items on a job',
  'green', (v_pol->'placement'->>'green_pct')::numeric, 'amber', (v_pol->'placement'->>'amber_pct')::numeric, 'higher_is_better', true,
  'status', CASE WHEN v_n = 0 THEN 'green' END,
  'value', v_d || ' of ' || v_n || ' Xero and quote items in ' || (v_pol->>'window_days') || ' days are on a job', 'note', 'placed share'));
 SELECT count(*) AS queued, count(*) FILTER (WHERE cardinality(b.candidate_job_ids) > 0) AS with_candidate INTO v_x
 FROM public.business_events b
 WHERE coalesce(b.context_captured_at, b.recorded_at) > v_from AND coalesce(b.context_captured_at, b.recorded_at) <= v_as_of
   AND b.job_id IS NULL AND b.attribution_status IN ('admin_bucket', 'unplaced', 'pending_luna', 'review');
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 3, 'lane', 'review_queue',
  'number', CASE WHEN v_x.queued = 0 THEN NULL ELSE trunc(100.0 * v_x.with_candidate / v_x.queued, 1) END,
  'unit', '% of unplaced items with a candidate job', 'green', (v_pol->'review_queue'->>'green_pct')::numeric,
  'amber', (v_pol->'review_queue'->>'amber_pct')::numeric, 'higher_is_better', true,
  'status', CASE WHEN v_x.queued = 0 THEN 'green' END,
  'value', v_x.with_candidate || ' of ' || v_x.queued || ' unplaced items in ' || (v_pol->>'window_days') || ' days have a candidate job',
  'note', 'admin_bucket, unplaced, pending_luna and review rows with no job'));
 -- Known misfiles: a row whose own payload names another job, and every row on
 -- a holding job (never a customer's job), each counted once.
 v_mis := public.context_placement_misfile_counts(v_as_of);
 v_n := coalesce((v_mis->>'payload_mismatch')::numeric, 0) - coalesce((v_mis->>'payload_mismatch_on_holding_job')::numeric, 0)
        + coalesce((v_mis->>'on_holding_job')::numeric, 0);
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 3, 'lane', 'known_misfiles',
  'number', v_n, 'unit', 'rows on a job other than their own: their payload names another job, or they sit on a holding job',
  'green', 0, 'amber', 0, 'higher_is_better', false,
  'value', v_n || ' known misfiles: ' || coalesce(v_mis->>'on_holding_job', '0') || ' on a holding job ('
           || coalesce(v_mis->>'on_holding_job_customer_facing_30d', '0') || ' customer-facing in ' || (v_pol->>'window_days') || ' days), '
           || coalesce(v_mis->>'payload_mismatch', '0') || ' naming another job in their payload ('
           || coalesce(v_mis->>'payload_mismatch_on_holding_job', '0') || ' of them on a holding job, '
           || coalesce(v_mis->'payload_mismatch_by_class'->>'repoint', '0') || ' the repair can move)',
  'note', 'context_placement_misfile_counts (read only); ' || coalesce(v_mis->>'live_bindings_to_holding_job', '0')
          || ' live thread bindings point at a holding job'));
 -- Right-job accuracy: the newest graded sample of each population.
 FOR v_txt IN SELECT jsonb_array_elements_text(v_pol->'right_job'->'populations') LOOP
  SELECT * INTO v_pg FROM public.context_placement_grades_newest(v_as_of, v_txt) g;
  v_why := '{}';
  IF coalesce(v_pg.samples, 0) = 0 THEN v_why := v_why || 'no graded sample'::text;
  ELSE
   IF coalesce(v_pg.missing, 0) > 0 THEN v_why := v_why || format('%s of %s drawn items not graded', v_pg.missing, v_pg.drawn); END IF;
   IF coalesce(v_pg.drawn, 0) < (v_pol->'right_job'->>'min_drawn')::integer THEN
    v_why := v_why || format('%s drawn, at least %s needed', coalesce(v_pg.drawn, 0), v_pol->'right_job'->>'min_drawn');
   END IF;
   IF v_pg.right_of_all IS NULL THEN v_why := v_why || 'no right share'::text; END IF;
  END IF;
  v_n := CASE WHEN v_pg.right_of_all IS NULL THEN NULL ELSE trunc(100 * v_pg.right_of_all, 2) END;
  v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 3, 'lane', 'right_job_' || v_txt,
   'number', v_n, 'unit', '% of ' || replace(v_txt, '_', ' ') || ' items on the right job (graded sample, of all items)',
   'green', (v_pol->'right_job'->>'green_pct')::numeric, 'amber', (v_pol->'right_job'->>'amber_pct')::numeric, 'higher_is_better', true,
   'status', CASE WHEN cardinality(v_why) > 0 THEN 'red' END,
   'value', CASE WHEN coalesce(v_pg.samples, 0) = 0 THEN 'no graded placement sample of ' || replace(v_txt, '_', ' ') || ' items'
                 ELSE v_pg.right_count || ' right, ' || v_pg.wrong_count || ' wrong, ' || v_pg.unsure_count || ' unsure of ' || v_pg.drawn
                      || ' drawn (sample ' || v_pg.sample_id || ', drawn as of '
                      || to_char(v_pg.as_of AT TIME ZONE 'Australia/Perth', 'FMDD Mon YYYY HH24:MI') || ' Perth); placed share '
                      || coalesce(trunc(100 * v_pg.placed_share, 1)::text, '?') || '%' END,
   'note', CASE WHEN cardinality(v_why) > 0 THEN array_to_string(v_why, '; ') || '; ' ELSE '' END
           || 'context_placement_grades_newest: right of all = least(right share, weighted right share) x placed share; '
           || 'green on a whole sample of at least ' || (v_pol->'right_job'->>'min_drawn') || ' items'));
 END LOOP;

 ---------------------------------------------------------------------------
 -- Row 4. History: loaded for every monitored live job, loads running daily until complete.
 v_crm := public.context_history_crm_summary();
 v_n := coalesce((v_crm->>'monitored_jobs')::numeric, 0);
 v_d := coalesce((v_crm->>'done')::numeric, 0);
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 4, 'lane', 'ghl_history',
  'number', CASE WHEN v_n = 0 THEN NULL ELSE trunc(100.0 * v_d / v_n, 1) END,
  'unit', '% of monitored live jobs with their CRM history done (loaded, or tried with no CRM contact)',
  'green', (v_pol->'history'->>'green_pct')::numeric, 'amber', (v_pol->'history'->>'amber_pct')::numeric, 'higher_is_better', true,
  'status', CASE WHEN coalesce(v_crm->>'lead_rule', '') <> (v_pol->'history'->>'crm_lead_rule') THEN 'red' WHEN v_n = 0 THEN 'green' END,
  'value', v_d || ' of ' || v_n || ' monitored live jobs have their CRM texts, calls and emails: ' || coalesce(v_crm->>'loaded', '0')
           || ' loaded, ' || coalesce(v_crm->>'tried_no_contact', '0') || ' tried with no CRM contact; ' || coalesce(v_crm->>'missing', '0') || ' missing',
  'note', CASE WHEN coalesce(v_crm->>'lead_rule', '') <> (v_pol->'history'->>'crm_lead_rule')
               THEN 'the lead rule is not deciding the CRM read (' || coalesce(v_crm->>'lead_rule', '?') || '); ' ELSE '' END
          || 'done = loaded or tried with no CRM contact (desk decision B-2: a job whose customer is not in the CRM has no CRM history to load); '
          || 'done definition row 4: "Every live job has its past GHL texts/calls/emails, its Outlook email history and its Xero history loaded"; missing by reason: '
          || coalesce((SELECT string_agg(r.key || ' ' || r.value, ', ' ORDER BY r.key COLLATE "C") FROM jsonb_each_text(v_crm->'missing_by_reason') r), 'none')
          || '; context_history_crm_summary, read as now'));
 v_n := coalesce((v_eh->>'sources')::numeric, 0);
 v_d := coalesce((v_eh->'by_state'->>'succeeded')::numeric, 0);
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 4, 'lane', 'email_history',
  'number', CASE WHEN v_n = 0 THEN NULL ELSE trunc(100.0 * v_d / v_n, 1) END, 'unit', '% of mailbox sources with history finished',
  'green', (v_pol->'history'->>'green_pct')::numeric, 'amber', (v_pol->'history'->>'amber_pct')::numeric, 'higher_is_better', true,
  'value', v_d || ' of ' || v_n || ' mailbox sources finished',
  'note', coalesce((SELECT string_agg(s.key || ' ' || s.value, ', ' ORDER BY s.key COLLATE "C") FROM jsonb_each_text(v_eh->'by_state') s), 'no plan')));
 v_xd := public.context_history_xero_daily_status();
 SELECT count(DISTINCT x.job_id), count(DISTINCT x.job_id) FILTER (WHERE EXISTS (
          SELECT 1 FROM public.business_events b WHERE b.job_id = x.job_id AND coalesce(b.context_captured_at, b.recorded_at) <= v_as_of
            AND (b.source LIKE 'xero%' OR b.event_type LIKE 'invoice.%' OR b.event_type LIKE 'payment.%')))
 INTO v_n, v_d
 FROM public.xero_invoices x
 WHERE x.job_id = ANY (v_mon) AND coalesce(x.status, '') NOT IN ('VOIDED', 'DELETED') AND coalesce(x.invoice_type, 'ACCREC') = 'ACCREC';
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 4, 'lane', 'xero_history',
  'number', CASE WHEN v_n = 0 THEN NULL ELSE trunc(100.0 * v_d / v_n, 1) END, 'unit', '% of invoiced monitored live jobs with Xero evidence',
  'green', (v_pol->'history'->>'green_pct')::numeric, 'amber', (v_pol->'history'->>'amber_pct')::numeric, 'higher_is_better', true,
  'status', CASE WHEN v_n = 0 THEN 'green' END,
  'value', v_d || ' of ' || v_n || ' monitored live jobs with a live Xero invoice carry Xero evidence',
  'note', 'invoices not voided or deleted; daily top-up ' || coalesce(v_xd->>'cron_jobname', '?') || ': '
          || CASE WHEN v_xd->'last_run' IS NULL OR jsonb_typeof(v_xd->'last_run') = 'null' THEN 'no run yet'
                  ELSE 'last run ' || coalesce(v_xd->'last_run'->>'status', '?') || ' '
                       || coalesce(to_char((v_xd->'last_run'->>'started_at')::timestamptz AT TIME ZONE 'Australia/Perth', 'FMDD Mon HH24:MI'), '?') || ' Perth' END
          || ', ' || coalesce(v_xd->'plan'->>'missing_rows', '?') || ' evidence rows still missing (context_history_xero_daily_status, read as now)'));
 -- History loads that stopped moving (unchanged).
 v_n := 0; v_missing := '{}';
 FOR v_x IN
  SELECT s.source, count(*) AS runs, bool_and(s.status = 'partial') AS all_partial,
         sum((SELECT coalesce(sum((s.counts->>k)::numeric), 0) FROM jsonb_array_elements_text(v_pol->'history_progress_keys') k
              WHERE jsonb_typeof(s.counts->k) = 'number')) AS added,
         count(DISTINCT md5(coalesce(s.cursor::text, ''))) AS cursors, max(s.started_at) AS last_run, min(s.started_at) AS first_run
  FROM (SELECT c.source, c.status, c.counts, c.cursor, c.started_at,
               row_number() OVER (PARTITION BY c.source ORDER BY c.started_at DESC) AS rn
        FROM public.context_capture_runs c
        WHERE c.started_at <= v_as_of AND c.started_at > v_as_of - interval '7 days' AND c.status <> 'running'
          AND (c.source LIKE '%history%' OR c.source LIKE '%backfill%') AND c.source NOT LIKE '%\_dry') s
  WHERE s.rn <= (v_pol->>'history_stall_runs')::integer
  GROUP BY s.source ORDER BY s.source COLLATE "C"
 LOOP
  IF v_x.runs = (v_pol->>'history_stall_runs')::integer AND v_x.all_partial AND v_x.added = 0 AND v_x.cursors = 1 THEN
   v_n := v_n + 1; v_missing := v_missing || v_x.source::text;
   v_alarms := v_alarms || jsonb_build_array(jsonb_build_object('key', 'history_load_stalled', 'row', 4, 'source', v_x.source,
    'since', v_x.first_run, 'last_run_at', v_x.last_run, 'runs', v_x.runs,
    'what_to_do', 'This history load ran ' || v_x.runs || ' times in a row without adding, linking or finishing anything or moving its cursor, and still reports more to do. Check its run rows in context_capture_runs and the function''s logs.'));
  END IF;
 END LOOP;
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 4, 'lane', 'history_loads_stalled',
  'number', v_n, 'unit', 'history loads with no progress for ' || (v_pol->>'history_stall_runs') || ' runs', 'green', 0, 'amber', 0,
  'higher_is_better', false, 'value', v_n || ' stalled' || CASE WHEN cardinality(v_missing) > 0 THEN ': ' || array_to_string(v_missing, ', ') ELSE '' END,
  'note', 'runs in context_capture_runs over the last 7 days'));
 -- The cron jobs that keep each load daily. pg_cron row security can hide another role's job.
 v_missing := '{}';
 IF to_regclass('cron.job') IS NOT NULL THEN
  FOR v_x IN SELECT k.key AS load, k.value AS jobname FROM jsonb_each_text(v_pol->'history_schedules') k ORDER BY k.key COLLATE "C" LOOP
   IF v_x.jobname IS NULL THEN v_missing := v_missing || v_x.load;
   ELSE
    EXECUTE 'SELECT count(*) FROM cron.job WHERE jobname = $1 AND active' INTO v_n USING v_x.jobname;
    IF v_n = 0 THEN v_missing := v_missing || v_x.load; END IF;
   END IF;
  END LOOP;
 ELSE
  v_missing := ARRAY(SELECT k FROM jsonb_object_keys(v_pol->'history_schedules') k ORDER BY k COLLATE "C");
 END IF;
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 4, 'lane', 'history_schedules',
  'number', cardinality(v_missing), 'unit', 'history loads with no active daily job', 'green', 0, 'amber', 0, 'higher_is_better', false,
  'value', CASE WHEN cardinality(v_missing) = 0 THEN 'every history load has an active cron job'
                ELSE 'no active cron job for: ' || array_to_string(v_missing, ', ') END,
  'note', 'cron job names in context_scorecard_policy().history_schedules (ghl ' || (v_pol->'history_schedules'->>'ghl')
          || ', email ' || (v_pol->'history_schedules'->>'email') || ', xero ' || (v_pol->'history_schedules'->>'xero') || ')'));

 ---------------------------------------------------------------------------
 -- Row 5. Documents (unchanged).
 v_n := coalesce((v_dt->'documents'->>'total')::numeric, 0);
 v_d := coalesce((v_dt->'documents'->>'with_text')::numeric, 0);
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 5, 'lane', 'document_text',
  'number', CASE WHEN v_n = 0 THEN NULL ELSE trunc(100.0 * v_d / v_n, 1) END, 'unit', '% of documents with readable text',
  'green', (v_pol->'documents'->>'green_pct')::numeric, 'amber', (v_pol->'documents'->>'amber_pct')::numeric, 'higher_is_better', true,
  'status', CASE WHEN v_n = 0 THEN 'green' END,
  'value', v_d || ' of ' || v_n || ' documents have text',
  'note', 'not tried ' || coalesce(v_dt->'documents'->>'never_tried', '?') || ', no text layer ' || coalesce(v_dt->'documents'->>'no_text_layer', '?')
          || ', too large ' || coalesce(v_dt->'documents'->>'too_large', '?') || ', too many pages ' || coalesce(v_dt->'documents'->>'too_many_pages', '?')));
 v_n := coalesce((v_vs->'documents'->>'waiting_for_vision')::numeric, 0);
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 5, 'lane', 'scans_and_photos',
  'number', v_n, 'unit', 'scans and photos waiting for the vision reader', 'green', 0, 'amber', NULL, 'higher_is_better', false,
  'status', CASE WHEN v_n = 0 THEN 'green' WHEN coalesce((v_vs->'flag'->>'enabled')::boolean, false) THEN 'amber' ELSE 'red' END,
  'value', v_n || ' waiting; vision reader ' || CASE WHEN coalesce((v_vs->'flag'->>'enabled')::boolean, false) THEN 'on' ELSE 'off' END,
  'note', 'red while documents wait and the reader is off (nothing will read them)'));
 v_n := jsonb_array_length(coalesce(v_dt->'alarms', '[]')) + jsonb_array_length(coalesce(v_vs->'alarms', '[]'));
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 5, 'lane', 'document_reader_alarms',
  'number', v_n, 'unit', 'document reader alarms', 'green', 0, 'amber', 0, 'higher_is_better', false,
  'value', v_n || ' alarms', 'note', 'context_document_text_status and context_document_vision_status'));

 ---------------------------------------------------------------------------
 -- Row 6. Reading, on the AI reader (the job ledger): an item is read when the
 -- job's live reading at the instant has read it (its evidence_until is at or
 -- after the item's landed_at). Copies are never counted. A live item must be
 -- read within 2 hours; the backlog (backfill and relinked rows) is 0 each morning.
 WITH lr AS (   -- each monitored job's live reading at the instant
  SELECT DISTINCT ON (g.job_id) g.job_id, g.evidence_until
  FROM public.context_ledger_generations g
  WHERE g.job_id = ANY (v_mon) AND g.promoted_at IS NOT NULL AND g.promoted_at <= v_as_of
    AND (g.status = 'live' OR (g.status = 'retired' AND g.retired_at > v_as_of))
  ORDER BY g.job_id, g.promoted_at DESC, g.id
 ), sh AS (     -- the newest passing shadow reading, for the note only (a shadow is never read here)
  SELECT DISTINCT ON (g.job_id) g.job_id, g.evidence_until
  FROM public.context_ledger_generations g
  WHERE g.job_id = ANY (v_mon) AND g.status = 'shadow' AND public.context_ledger_checks_pass(g.checks) AND g.created_at <= v_as_of
  ORDER BY g.job_id, g.created_at DESC, g.id
 ), er AS (
  SELECT r.job_id, r.src_table, r.src_id, r.landed_at FROM public.context_ledger_evidence_rows(v_mon, v_as_of) r WHERE r.copy_of IS NULL
 ), u AS (
  SELECT er.job_id, er.landed_at, lr.job_id IS NOT NULL AS has_live, sh.evidence_until AS sh_until,
         CASE WHEN er.src_table = 'business_events' THEN coalesce(b.metadata->>'capture_mode', 'live') NOT IN ('backfill', 'relink')
              ELSE true END AS live_mode
  FROM er LEFT JOIN lr ON lr.job_id = er.job_id LEFT JOIN sh ON sh.job_id = er.job_id
  LEFT JOIN public.business_events b ON er.src_table = 'business_events' AND b.id = er.src_id
  WHERE lr.evidence_until IS NULL OR er.landed_at > lr.evidence_until
 )
 SELECT (SELECT count(*) FROM er) AS evidence_n, (SELECT count(DISTINCT er.job_id) FROM er) AS evidence_jobs,
        (SELECT count(DISTINCT er.job_id) FROM er WHERE NOT EXISTS (SELECT 1 FROM lr WHERE lr.job_id = er.job_id)) AS jobs_no_live,
        count(*) FILTER (WHERE u.live_mode) AS live_n,
        count(*) FILTER (WHERE u.live_mode AND u.landed_at < v_as_of - make_interval(mins => (v_pol->'reading'->>'live_max_minutes')::integer)) AS live_late,
        min(u.landed_at) FILTER (WHERE u.live_mode) AS live_oldest,
        count(*) FILTER (WHERE NOT u.live_mode) AS backlog_n, count(DISTINCT u.job_id) FILTER (WHERE NOT u.live_mode) AS backlog_jobs,
        min(u.landed_at) FILTER (WHERE NOT u.live_mode) AS backlog_oldest,
        count(*) FILTER (WHERE u.sh_until IS NOT NULL AND u.landed_at <= u.sh_until) AS shadow_read
 INTO v_x FROM u;
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 6, 'lane', 'live_unread',
  'number', v_x.live_late, 'unit', 'live items unread by the live reading for more than ' || (v_pol->'reading'->>'live_max_minutes') || ' minutes',
  'green', 0, 'amber', 0, 'higher_is_better', false,
  'value', v_x.live_late || ' late of ' || v_x.live_n || ' live items unread'
           || coalesce('; oldest ' || trunc(extract(epoch FROM v_as_of - v_x.live_oldest) / 3600.0, 1) || ' h', ''),
  'note', 'the AI reader: an item (context_ledger_evidence_rows, not a copy) is read once the job''s live ledger reading has read it; '
          || v_x.evidence_n || ' items on ' || v_x.evidence_jobs || ' of ' || v_mon_n || ' monitored live jobs, ' || v_x.jobs_no_live
          || ' of those jobs with no live reading; ' || v_x.shadow_read || ' unread items are read by a passing shadow reading that is not live'));
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 6, 'lane', 'backlog_unread',
  'number', v_x.backlog_n, 'unit', 'backfill and relinked items unread by the live reading on monitored live jobs', 'green', 0, 'amber', NULL,
  'higher_is_better', false,
  'status', CASE WHEN v_x.backlog_n = 0 THEN 'green'
                 WHEN v_x.backlog_oldest >= v_as_of - make_interval(hours => (v_pol->'reading'->>'backlog_max_hours')::integer) THEN 'amber'
                 ELSE 'red' END,
  'value', v_x.backlog_n || ' rows on ' || v_x.backlog_jobs || ' jobs'
           || coalesce('; oldest ' || trunc(extract(epoch FROM v_as_of - v_x.backlog_oldest) / 3600.0, 1) || ' h', ''),
  'note', 'red once a backlog row has waited more than ' || (v_pol->'reading'->>'backlog_max_hours') || ' h'));
 SELECT count(*), count(*) FILTER (WHERE r.status = 'failed' OR coalesce(r.error, '') = 'checks_failed') INTO v_n, v_d
 FROM public.context_extraction_runs r
 WHERE r.phase = (v_pol->'reading'->>'run_phase') AND r.run_date = (v_as_of AT TIME ZONE 'Australia/Perth')::date AND r.started_at <= v_as_of
   AND coalesce(r.error, '') NOT LIKE 'released:%';
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 6, 'lane', 'failed_reads_today',
  'number', CASE WHEN v_n = 0 THEN 0 ELSE round(ceil(1000.0 * v_d / v_n) / 10, 1) END, 'unit', '% of today''s ledger reads that failed (Perth day)',
  'green', 0, 'amber', (v_pol->'reading'->>'failed_amber_pct')::numeric, 'higher_is_better', false,
  'value', v_d || ' failed of ' || v_n || ' ledger reads today', 'note', 'context_extraction_runs, phase ledger (failed, or done with checks_failed)'));

 ---------------------------------------------------------------------------
 -- Row 7. Facts: the published catalogue of ledger item kinds, and the ledger grade.
 SELECT count(*) AS kinds, count(*) FILTER (WHERE k.meaning IS NOT NULL AND k.accepted) AS ok,
        string_agg(k.item_type, ', ' ORDER BY k.ord, k.item_type COLLATE "C") FILTER (WHERE k.meaning IS NULL OR NOT k.accepted) AS bad
 INTO v_k FROM public.context_item_kinds() k;
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 7, 'lane', 'fact_catalogue',
  'number', v_k.ok, 'unit', 'ledger item kinds published with a meaning and accepted by the store', 'green', v_k.kinds, 'amber', NULL,
  'higher_is_better', true, 'status', CASE WHEN v_k.kinds > 0 AND v_k.ok = v_k.kinds THEN 'green' ELSE 'red' END,
  'value', v_k.ok || ' of ' || v_k.kinds || ' kinds published and accepted' || coalesce('; not: ' || v_k.bad, ''),
  'note', 'context_item_kinds: every kind the ledger store accepts, with its meaning'));
 SELECT * INTO v_g FROM public.context_grades_newest(v_as_of) g WHERE g.kind = v_pol->'facts'->>'grade_kind';
 v_why := '{}';
 IF coalesce(v_g.samples, 0) = 0 OR coalesce(v_g.units, 0) = 0 THEN v_why := v_why || 'no graded sample'::text;
 ELSE
  IF v_g.jobs < (v_pol->'facts'->>'min_jobs')::integer THEN v_why := v_why || format('%s jobs, at least %s needed', v_g.jobs, v_pol->'facts'->>'min_jobs'); END IF;
  IF v_g.passed * 100 < (v_pol->'facts'->>'green_pct')::numeric * v_g.units THEN
   v_why := v_why || format('%s of %s items pass, at least %s%% needed', v_g.passed, v_g.units, v_pol->'facts'->>'green_pct');
  END IF;
  IF v_g.unsafe_lines > (v_pol->'facts'->>'max_unsafe_lines')::integer THEN v_why := v_why || format('%s unsafe items', v_g.unsafe_lines); END IF;
  IF coalesce((v_g.readings->>'gated_on_live')::integer, 0) <> v_g.units THEN
   v_why := v_why || format('%s of %s items graded on a reading that is live now', coalesce(v_g.readings->>'gated_on_live', '0'), v_g.units);
  END IF;
 END IF;
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 7, 'lane', 'fact_grade',
  'number', v_g.pass_pct, 'unit', '% of ledger items an independent grader passes (10-job sample)',
  'green', (v_pol->'facts'->>'green_pct')::numeric, 'amber', NULL, 'higher_is_better', true,
  'status', CASE WHEN cardinality(v_why) = 0 THEN 'green' ELSE 'red' END,
  'value', CASE WHEN coalesce(v_g.samples, 0) = 0 THEN 'no ledger grade is stored'
                ELSE v_g.passed || ' of ' || v_g.units || ' items pass on ' || v_g.jobs || ' jobs (sample ' || v_g.sample_id || ', graded '
                     || to_char(v_g.graded_at AT TIME ZONE 'Australia/Perth', 'FMDD Mon YYYY') || ')' END,
  'note', CASE WHEN cardinality(v_why) > 0 THEN array_to_string(v_why, '; ') ELSE 'every bar met' END
          || CASE WHEN coalesce(v_g.samples, 0) > 0 THEN '; verbatim ' || coalesce(v_g.tests->'verbatim'->>'passed', '?') || ', parties '
                  || coalesce(v_g.tests->'parties'->>'passed', '?') || ', supported ' || coalesce(v_g.tests->'supported'->>'passed', '?')
                  || ' of ' || coalesce(v_g.tests->'verbatim'->>'graded', '?') ELSE '' END
          || '; context_grades_newest (readings as they stand now)'));

 ---------------------------------------------------------------------------
 -- Row 8. Job answer: the story grade, every bar.
 SELECT * INTO v_g FROM public.context_grades_newest(v_as_of) g WHERE g.kind = v_pol->'answer'->>'grade_kind';
 v_why := '{}';
 IF coalesce(v_g.samples, 0) = 0 OR coalesce(v_g.units, 0) = 0 THEN v_why := v_why || 'no graded sample'::text;
 ELSE
  IF v_g.jobs < (v_pol->'answer'->>'min_jobs')::integer THEN v_why := v_why || format('%s jobs, at least %s needed', v_g.jobs, v_pol->'answer'->>'min_jobs'); END IF;
  IF coalesce((v_g.readings->>'gated_on_live')::integer, 0) <> v_g.units THEN
   v_why := v_why || format('%s of %s cards graded on a reading that is live now', coalesce(v_g.readings->>'gated_on_live', '0'), v_g.units);
  END IF;
  FOR v_txt IN SELECT unnest(ARRAY['timeline', 'record_loops', 'recall.money', 'recall.record', 'recall.message', 'precision',
                                   'first_line', 'money', 'dates', 'honesty']) LOOP
   IF coalesce((v_g.tests #>> (string_to_array(v_txt, '.') || 'graded'::text))::integer, -1) <> v_g.units THEN
    v_why := v_why || format('%s graded on %s of %s cards', v_txt, coalesce(v_g.tests #>> (string_to_array(v_txt, '.') || 'graded'::text), '0'), v_g.units);
   END IF;
  END LOOP;
  FOR v_txt IN SELECT jsonb_array_elements_text(v_pol->'answer'->'card_tests') LOOP
   IF coalesce((v_g.tests->v_txt->>'passed')::integer, -1) <> coalesce((v_g.tests->v_txt->>'graded')::integer, -2) THEN
    v_why := v_why || format('%s passed on %s of %s cards', v_txt, coalesce(v_g.tests->v_txt->>'passed', '0'), coalesce(v_g.tests->v_txt->>'graded', '0'));
   END IF;
  END LOOP;
  FOR v_txt IN SELECT unnest(ARRAY['money', 'record']) LOOP
   IF coalesce((v_g.tests->'recall'->v_txt->>'found')::integer, -1) <> coalesce((v_g.tests->'recall'->v_txt->>'total')::integer, -2) THEN
    v_why := v_why || format('%s recall %s of %s', v_txt, coalesce(v_g.tests->'recall'->v_txt->>'found', '0'), coalesce(v_g.tests->'recall'->v_txt->>'total', '0'));
   END IF;
  END LOOP;
  IF coalesce((v_g.tests->'recall'->'message'->>'found')::numeric, 0) * 100
     < (v_pol->'answer'->>'recall_message_pct')::numeric * coalesce((v_g.tests->'recall'->'message'->>'total')::numeric, 0) THEN
   v_why := v_why || format('message recall %s of %s, at least %s%% needed', v_g.tests->'recall'->'message'->>'found',
                            v_g.tests->'recall'->'message'->>'total', v_pol->'answer'->>'recall_message_pct');
  END IF;
  IF coalesce((v_g.tests->'precision'->>'real')::numeric, 0) * 100
     < (v_pol->'answer'->>'precision_pct')::numeric * coalesce((v_g.tests->'precision'->>'shown')::numeric, 0) THEN
   v_why := v_why || format('precision %s of %s, at least %s%% needed', v_g.tests->'precision'->>'real', v_g.tests->'precision'->>'shown',
                            v_pol->'answer'->>'precision_pct');
  END IF;
  IF coalesce((v_g.tests->'first_line'->'known'->>'passed')::integer, -1) <> coalesce((v_g.tests->'first_line'->'known'->>'graded')::integer, -2) THEN
   v_why := v_why || format('known first lines right on %s of %s', coalesce(v_g.tests->'first_line'->'known'->>'passed', '0'),
                            coalesce(v_g.tests->'first_line'->'known'->>'graded', '0'));
  END IF;
  IF coalesce((v_g.tests->'first_line'->'unseen'->>'passed')::numeric, 0) * 100
     < (v_pol->'answer'->>'unseen_first_line_pct')::numeric * coalesce((v_g.tests->'first_line'->'unseen'->>'graded')::numeric, 0) THEN
   v_why := v_why || format('unseen first lines right on %s of %s, at least %s%% needed', v_g.tests->'first_line'->'unseen'->>'passed',
                            v_g.tests->'first_line'->'unseen'->>'graded', v_pol->'answer'->>'unseen_first_line_pct');
  END IF;
  IF v_g.unsafe_lines > (v_pol->'answer'->>'max_unsafe_lines')::integer THEN v_why := v_why || format('%s unsafe lines', v_g.unsafe_lines); END IF;
 END IF;
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 8, 'lane', 'answer_grade',
  'number', CASE WHEN coalesce(v_g.samples, 0) = 0 OR coalesce(v_g.units, 0) = 0 THEN NULL ELSE cardinality(v_why) END,
  'unit', 'story grade bars missed (10-job sample)', 'green', 0, 'amber', NULL, 'higher_is_better', false,
  'status', CASE WHEN cardinality(v_why) = 0 THEN 'green' ELSE 'red' END,
  'value', CASE WHEN coalesce(v_g.samples, 0) = 0 THEN 'no story grade is stored'
                ELSE v_g.units || ' story cards on ' || v_g.jobs || ' jobs (sample ' || v_g.sample_id || ', graded '
                     || to_char(v_g.graded_at AT TIME ZONE 'Australia/Perth', 'FMDD Mon YYYY') || '); ' || v_g.passed || ' pass every card test' END,
  'note', CASE WHEN cardinality(v_why) > 0 THEN array_to_string(v_why, '; ') ELSE 'every bar met' END
          || '; the job story card (records plus the live ledger); context_grades_newest (readings as they stand now)'));

 ---------------------------------------------------------------------------
 -- Row 9. Agent use (and 9+, the story test): the T7 agent grade.
 SELECT * INTO v_g FROM public.context_grades_newest(v_as_of) g WHERE g.kind = v_pol->'agent'->>'grade_kind';
 v_why := '{}';
 IF coalesce(v_g.samples, 0) = 0 OR coalesce(v_g.units, 0) = 0 THEN v_why := v_why || 'no graded agent test'::text;
 ELSE
  IF v_g.jobs < (v_pol->'agent'->>'min_jobs')::integer THEN v_why := v_why || format('%s jobs, at least %s needed', v_g.jobs, v_pol->'agent'->>'min_jobs'); END IF;
  IF v_g.unsafe_lines > (v_pol->'agent'->>'max_unsafe_lines')::integer THEN v_why := v_why || format('%s unsafe lines', v_g.unsafe_lines); END IF;
  IF coalesce((v_g.readings->>'gated_on_live')::integer, 0) <> v_g.units THEN
   v_why := v_why || format('%s of %s calls graded on a reading that is live now', coalesce(v_g.readings->>'gated_on_live', '0'), v_g.units);
  END IF;
  IF (v_pol->'agent'->>'story_flag_required')::boolean AND coalesce((v_g.run->>'story_flag_on')::integer, 0) <> v_g.units THEN
   v_why := v_why || format('%s of %s calls ran with the story switch on', coalesce(v_g.run->>'story_flag_on', '0'), v_g.units);
  END IF;
  IF (v_pol->'agent'->>'ledger_mode_live_gates')::boolean AND coalesce((v_g.run->>'ledger_live')::integer, 0) <> v_g.units THEN
   v_why := v_why || format('%s of %s calls ran with the ledger live', coalesce(v_g.run->>'ledger_live', '0'), v_g.units);
  END IF;
  IF (v_pol->'agent'->>'story_tool_missed_gates')::boolean AND coalesce((v_g.tests->>'story_tool_missed')::integer, 0) > 0 THEN
   v_why := v_why || format('%s calls answered without a story tool', v_g.tests->>'story_tool_missed');
  END IF;
 END IF;
 -- 9: the baseline (where at, last told, owed).
 v_missing := v_why;
 IF coalesce(v_g.samples, 0) > 0 AND coalesce(v_g.units, 0) > 0 THEN
  IF coalesce((v_g.tests->'baseline'->>'graded')::integer, 0) < (v_pol->'agent'->>'baseline_calls')::integer THEN
   v_missing := v_missing || format('%s baseline calls graded, at least %s needed', coalesce(v_g.tests->'baseline'->>'graded', '0'),
                                    v_pol->'agent'->>'baseline_calls');
  END IF;
  IF coalesce((v_g.tests->'baseline'->>'passed')::integer, -1) <> coalesce((v_g.tests->'baseline'->>'graded')::integer, -2) THEN
   v_missing := v_missing || format('%s of %s baseline answers correct', coalesce(v_g.tests->'baseline'->>'passed', '0'),
                                    coalesce(v_g.tests->'baseline'->>'graded', '0'));
  END IF;
 END IF;
 v_n := coalesce((v_g.tests->'baseline'->>'graded')::numeric, 0);
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 9, 'lane', 'agent_test',
  'number', CASE WHEN v_n = 0 THEN NULL ELSE trunc(100.0 * (v_g.tests->'baseline'->>'passed')::numeric / v_n, 1) END,
  'unit', '% correct on the 10-job test set (where at, last told, owed)', 'green', 100, 'amber', NULL, 'higher_is_better', true,
  'status', CASE WHEN cardinality(v_missing) = 0 THEN 'green' ELSE 'red' END,
  'value', CASE WHEN coalesce(v_g.samples, 0) = 0 THEN 'no agent test is stored'
                ELSE coalesce(v_g.tests->'baseline'->>'passed', '0') || ' of ' || coalesce(v_g.tests->'baseline'->>'graded', '0')
                     || ' baseline answers correct on ' || v_g.jobs || ' jobs (sample ' || v_g.sample_id || ', graded '
                     || to_char(v_g.graded_at AT TIME ZONE 'Australia/Perth', 'FMDD Mon YYYY') || ')' END,
  'note', CASE WHEN cardinality(v_missing) > 0 THEN array_to_string(v_missing, '; ') ELSE 'every bar met' END
          || CASE WHEN coalesce(v_g.samples, 0) > 0 THEN '; ' || coalesce(v_g.tests->>'story_tool_missed', '0')
                  || ' calls answered without a story tool (listed, not gated); ledger mode at the run: live '
                  || coalesce(v_g.run->>'ledger_live', '0') || ', shadow ' || coalesce(v_g.run->>'ledger_shadow', '0') ELSE '' END));
 -- 9+: the story test.
 v_missing := v_why;
 IF coalesce(v_g.samples, 0) > 0 AND coalesce(v_g.units, 0) > 0 THEN
  IF coalesce((v_g.tests->'story'->>'graded')::integer, 0) < (v_pol->'agent'->>'story_calls')::integer THEN
   v_missing := v_missing || format('%s story calls graded, at least %s needed', coalesce(v_g.tests->'story'->>'graded', '0'),
                                    v_pol->'agent'->>'story_calls');
  END IF;
  IF coalesce((v_g.tests->'story'->>'passed')::integer, -1) <> coalesce((v_g.tests->'story'->>'graded')::integer, -2) THEN
   v_missing := v_missing || format('%s of %s story calls cover every should-surface loop', coalesce(v_g.tests->'story'->>'passed', '0'),
                                    coalesce(v_g.tests->'story'->>'graded', '0'));
  END IF;
 END IF;
 v_n := coalesce((v_g.tests->'story'->>'graded')::numeric, 0);
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 9, 'lane', 'story_test',
  'number', CASE WHEN v_n = 0 THEN NULL ELSE trunc(100.0 * (v_g.tests->'story'->>'passed')::numeric / v_n, 1) END,
  'unit', '% of "tell me the story of this job and what is outstanding" calls covering every should-surface loop', 'green', 100,
  'amber', NULL, 'higher_is_better', true,
  'status', CASE WHEN cardinality(v_missing) = 0 THEN 'green' ELSE 'red' END,
  'value', CASE WHEN coalesce(v_g.samples, 0) = 0 THEN 'no agent test is stored'
                ELSE coalesce(v_g.tests->'story'->>'passed', '0') || ' of ' || coalesce(v_g.tests->'story'->>'graded', '0')
                     || ' story calls pass; loops covered ' || coalesce(v_g.tests->'story'->>'loops_covered', '0') || ' of '
                     || coalesce(v_g.tests->'story'->>'loops_applicable', '0') END,
  'note', CASE WHEN cardinality(v_missing) > 0 THEN array_to_string(v_missing, '; ') ELSE 'every bar met' END || '; row 9+'));

 ---------------------------------------------------------------------------
 -- Row 10. Health: this read, and the hourly run (its own lane, as it is).
 v_run := public.context_scorecard_run_status(v_as_of);
 v_lanes := v_lanes || jsonb_build_array(
  jsonb_build_object('row', 10, 'lane', 'scorecard', 'number', 1, 'unit', 'one scorecard read for rows 1 to 14, per lane and per job',
   'green', 1, 'amber', NULL, 'higher_is_better', true, 'status', 'green', 'value', 'context_scorecard and context_scorecard_jobs answer',
   'note', 'this read; the job rows measure the ' || v_mon_n || ' monitored live jobs'),
  coalesce(v_run->'lane', jsonb_build_object('row', 10, 'lane', 'hourly_run', 'number', NULL, 'unit', 'run hourly, red rows reported',
   'green', NULL, 'amber', NULL, 'higher_is_better', true, 'status', 'red', 'value', 'not measurable here',
   'note', 'context_scorecard_run_status gave no lane')));

 ---------------------------------------------------------------------------
 -- Rows 11 to 13. Story, open loops, client view, on the monitored live jobs;
 -- a job's live ledger reading is the one live at the instant.
 WITH lr AS (
  SELECT DISTINCT ON (g.job_id) g.job_id, g.id
  FROM public.context_ledger_generations g
  WHERE g.job_id = ANY (v_mon) AND g.promoted_at IS NOT NULL AND g.promoted_at <= v_as_of
    AND (g.status = 'live' OR (g.status = 'retired' AND g.retired_at > v_as_of))
  ORDER BY g.job_id, g.promoted_at DESC, g.id
 )
 SELECT count(*) AS live_ledger,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.context_ledger_items i WHERE i.generation_id = lr.id AND i.item_type = 'phase_note')) AS with_notes,
        array_agg(lr.job_id ORDER BY lr.job_id) FILTER (WHERE EXISTS (SELECT 1 FROM public.context_ledger_items i
                                                                   WHERE i.generation_id = lr.id AND i.item_type = 'phase_note')) AS ids
 INTO v_x FROM lr;
 -- The record timeline is read only for jobs that already pass the ledger half.
 SELECT count(*) INTO v_n FROM (
  SELECT t.job_id FROM public.context_job_record_timeline(coalesce(v_x.ids, '{}'::uuid[]), v_as_of) t
  GROUP BY t.job_id HAVING count(*) >= (v_pol->'story'->>'timeline_min_rows')::integer) s;
 v_lanes := v_lanes || jsonb_build_array(
  jsonb_build_object('row', 11, 'lane', 'job_story', 'number', CASE WHEN v_mon_n = 0 THEN NULL ELSE trunc(100.0 * v_n / v_mon_n, 1) END,
   'unit', '% of monitored live jobs with a timeline and a live ledger with phase notes', 'green', (v_pol->'story'->>'green_pct')::numeric,
   'amber', (v_pol->'story'->>'amber_pct')::numeric, 'higher_is_better', true, 'status', CASE WHEN v_mon_n = 0 THEN 'green' END,
   'value', v_n || ' of ' || v_mon_n || ' monitored live jobs; ' || v_x.with_notes || ' have a live ledger with phase notes',
   'note', 'per job: context_scorecard_jobs'),
  jsonb_build_object('row', 12, 'lane', 'open_loops', 'number', CASE WHEN v_mon_n = 0 THEN NULL ELSE trunc(100.0 * v_x.live_ledger / v_mon_n, 1) END,
   'unit', '% of monitored live jobs with a live ledger (promises and asks come from the words)', 'green', (v_pol->'story'->>'green_pct')::numeric,
   'amber', (v_pol->'story'->>'amber_pct')::numeric, 'higher_is_better', true, 'status', CASE WHEN v_mon_n = 0 THEN 'green' END,
   'value', v_x.live_ledger || ' of ' || v_mon_n || ' monitored live jobs have a live ledger',
   'note', 'record loops (money owed, dates) are built for every job; the ledger adds what was promised and asked'));
 SELECT count(*) FILTER (WHERE nullif(btrim(j.ghl_contact_id), '') IS NOT NULL OR nullif(btrim(j.client_email), '') IS NOT NULL)
 INTO v_n FROM public.jobs j WHERE j.id = ANY (v_mon);
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 13, 'lane', 'client_identity',
  'number', CASE WHEN v_mon_n = 0 THEN NULL ELSE trunc(100.0 * v_n / v_mon_n, 1) END,
  'unit', '% of monitored live jobs that can be matched to their client', 'green', (v_pol->'story'->>'green_pct')::numeric,
  'amber', (v_pol->'story'->>'amber_pct')::numeric, 'higher_is_better', true,
  'status', CASE WHEN v_mon_n = 0 THEN 'green' END,
  'value', v_n || ' of ' || v_mon_n || ' monitored live jobs have a CRM contact or a client email',
  'note', 'the client view groups jobs by CRM contact, else exact client email'));

 ---------------------------------------------------------------------------
 -- Row 14. History depth: every lane back to each monitored live job's start.
 SELECT count(*) FILTER (WHERE s.first_email IS NOT NULL) AS email_jobs,
        count(*) FILTER (WHERE s.first_email <= s.created_at + make_interval(days => (v_pol->'depth'->>'start_days')::integer)) AS email_deep,
        count(*) FILTER (WHERE s.first_talk IS NOT NULL) AS talk_jobs,
        count(*) FILTER (WHERE s.first_talk <= s.created_at + make_interval(days => (v_pol->'depth'->>'start_days')::integer)) AS talk_deep
 INTO v_x
 FROM (SELECT j.id, j.created_at,
              min(coalesce(b.event_at, b.occurred_at)) FILTER (WHERE b.channel = 'email') AS first_email,
              min(coalesce(b.event_at, b.occurred_at)) FILTER (WHERE b.channel IN ('sms', 'call')) AS first_talk
       FROM public.jobs j LEFT JOIN public.business_events b ON b.job_id = j.id AND coalesce(b.context_captured_at, b.recorded_at) <= v_as_of
       WHERE j.id = ANY (v_mon) GROUP BY j.id, j.created_at) s;
 v_lanes := v_lanes || jsonb_build_array(
  jsonb_build_object('row', 14, 'lane', 'email_depth',
   'number', CASE WHEN v_x.email_jobs = 0 THEN NULL ELSE trunc(100.0 * v_x.email_deep / v_x.email_jobs, 1) END,
   'unit', '% of monitored live jobs with email whose earliest email is within ' || (v_pol->'depth'->>'start_days') || ' days of the job''s start',
   'green', (v_pol->'depth'->>'green_pct')::numeric, 'amber', (v_pol->'depth'->>'amber_pct')::numeric, 'higher_is_better', true,
   'status', CASE WHEN v_x.email_jobs = 0 THEN 'green' END,
   'value', v_x.email_deep || ' of ' || v_x.email_jobs || ' monitored live jobs with email', 'note', 'earliest email by event time'),
  jsonb_build_object('row', 14, 'lane', 'texts_calls_depth',
   'number', CASE WHEN v_x.talk_jobs = 0 THEN NULL ELSE trunc(100.0 * v_x.talk_deep / v_x.talk_jobs, 1) END,
   'unit', '% of monitored live jobs with texts or calls whose earliest one is within ' || (v_pol->'depth'->>'start_days') || ' days of the job''s start',
   'green', (v_pol->'depth'->>'green_pct')::numeric, 'amber', (v_pol->'depth'->>'amber_pct')::numeric, 'higher_is_better', true,
   'status', CASE WHEN v_x.talk_jobs = 0 THEN 'green' END,
   'value', v_x.talk_deep || ' of ' || v_x.talk_jobs || ' monitored live jobs with texts or calls', 'note', 'earliest text or call by event time'));
 SELECT min(p.window_from) INTO v_newest FROM public.context_email_history_plan p;
 SELECT count(*) FILTER (WHERE v_newest IS NOT NULL AND j.created_at >= v_newest) INTO v_n FROM public.jobs j WHERE j.id = ANY (v_mon);
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 14, 'lane', 'email_history_window',
  'number', CASE WHEN v_mon_n = 0 OR v_newest IS NULL THEN NULL ELSE trunc(100.0 * v_n / v_mon_n, 1) END,
  'unit', '% of monitored live jobs that started inside the email history window', 'green', (v_pol->'depth'->>'green_pct')::numeric,
  'amber', (v_pol->'depth'->>'amber_pct')::numeric, 'higher_is_better', true,
  'status', CASE WHEN v_mon_n = 0 THEN 'green' END,
  'value', CASE WHEN v_newest IS NULL THEN 'no email history window planned'
                ELSE 'window from ' || to_char((v_newest AT TIME ZONE 'Australia/Perth')::date, 'FMDD Mon YYYY') || '; '
                     || v_n || ' of ' || v_mon_n || ' monitored live jobs started inside it' END,
  'note', 'context_email_history_plan, earliest window_from'));
 -- The deep email load's reach: each monitored live job's email history loaded back to its start.
 v_reach := public.context_email_history_reach(v_as_of);
 v_n := coalesce((v_reach->'jobs'->>'monitored')::numeric, 0);
 v_d := coalesce((v_reach->'jobs'->>'reaches_start')::numeric, 0);
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 14, 'lane', 'email_reach',
  'number', CASE WHEN v_n = 0 THEN NULL ELSE trunc(100.0 * v_d / v_n, 1) END,
  'unit', '% of monitored live jobs whose email history is loaded back to their start', 'green', (v_pol->'depth'->>'green_pct')::numeric,
  'amber', (v_pol->'depth'->>'amber_pct')::numeric, 'higher_is_better', true,
  'status', CASE WHEN coalesce(v_reach->>'lead_rule', '') <> 'context_lead_monitored' THEN 'red' WHEN v_n = 0 THEN 'green' END,
  'value', v_d || ' of ' || v_n || ' monitored live jobs reach their start; loading ' || coalesce(v_reach->'jobs'->>'loading', '0')
           || ', short ' || coalesce(v_reach->'jobs'->>'short', '0') || ', not started ' || coalesce(v_reach->'jobs'->>'not_started', '0')
           || ', unknown start ' || coalesce(v_reach->'jobs'->>'unknown_start', '0'),
  'note', CASE WHEN coalesce(v_reach->>'lead_rule', '') <> 'context_lead_monitored'
               THEN 'the lead rule is not deciding the email reach (' || coalesce(v_reach->>'lead_rule', '?') || '); ' ELSE '' END
          || 'deep email load ' || CASE WHEN coalesce((v_reach->>'flag')::boolean, false) THEN 'on' ELSE 'off' END
          || '; mailboxes finished ' || coalesce(v_reach->>'mailboxes_finished', '0') || ' of ' || coalesce(v_reach->>'mailboxes_selected', '0')
          || '; context_email_history_reach'));

 ---------------------------------------------------------------------------
 -- Grade every lane, fold lanes into rows, and answer.
 WITH lanes AS (
  SELECT l.ord, l.v || jsonb_build_object('status', coalesce(l.v->>'status',
          CASE WHEN l.v->'number' IS NULL OR jsonb_typeof(l.v->'number') = 'null' THEN 'red'
               WHEN (l.v->>'higher_is_better')::boolean THEN
                CASE WHEN (l.v->>'number')::numeric >= (l.v->>'green')::numeric THEN 'green'
                     WHEN (l.v->>'amber') IS NOT NULL AND (l.v->>'number')::numeric >= (l.v->>'amber')::numeric THEN 'amber' ELSE 'red' END
               ELSE
                CASE WHEN (l.v->>'number')::numeric <= (l.v->>'green')::numeric THEN 'green'
                     WHEN (l.v->>'amber') IS NOT NULL AND (l.v->>'number')::numeric <= (l.v->>'amber')::numeric THEN 'amber' ELSE 'red' END
          END)) AS v
  FROM jsonb_array_elements(v_lanes) WITH ORDINALITY AS l(v, ord)
 ),
 stages(rn, stage, green_when) AS (VALUES
  (1, 'Capture: every lane live', 'every lane shows new items within its lag; an alarm fires when a lane goes quiet'),
  (2, 'Who-to-whom', 'every message carries sender and recipient role; crew and staff texts stay on their job, labelled internal'),
  (3, 'Placement', 'at least 95% of customer-facing and Xero/quote items on the right job; the rest in a review queue with a candidate; zero known misfiles'),
  (4, 'History', 'every monitored live job has its CRM history (loaded, or tried with no CRM contact), its email and its Xero history loaded; loads run daily until complete'),
  (5, 'Documents', 'text inside uploaded documents is extracted and readable as evidence'),
  (6, 'Reading', 'every placed item on a monitored live job is read by its live AI reading (the job ledger) within 2 hours; the unread backlog is 0 each morning'),
  (7, 'Facts', 'a published catalogue of ledger item kinds; an independent grader passes at least 95% of ledger items on a 10-job sample, graded on live readings'),
  (8, 'Job answer', 'the job story card is correct on an independently graded 10-job sample: every bar of the story grade met, graded on live readings'),
  (9, 'Agent use', 'with the story switch on, the agent answers where a job is at, what we last told the customer and what is owed for the 10-job test set (30 of 30); 9+: the story test covers every should-surface loop'),
  (10, 'Health', 'one scorecard shows rows 1 to 9 per lane and per job; Rayleigh runs it hourly and reports only red rows'),
  (11, 'Job story', 'every monitored live job has a start-to-finish timeline with a cited summary per phase'),
  (12, 'Open loops', 'every monitored live job lists what is promised, asked, owed and unconfirmed, each with why and its source'),
  (13, 'Client view', 'every client with a monitored live job has one view across all their jobs'),
  (14, 'History depth', 'every lane for monitored live jobs is loaded back to each job''s start')
 ),
 rows_ AS (
  SELECT s.rn, s.stage, s.green_when,
         CASE WHEN bool_or(l.v->>'status' = 'red') THEN 'red' WHEN bool_or(l.v->>'status' = 'amber') THEN 'amber' ELSE 'green' END AS status,
         jsonb_agg(l.v - 'row' - 'higher_is_better' ORDER BY l.ord) AS lanes
  FROM stages s JOIN lanes l ON (l.v->>'row')::integer = s.rn
  GROUP BY s.rn, s.stage, s.green_when
 )
 SELECT jsonb_agg(jsonb_build_object('row', r.rn, 'stage', r.stage, 'green_when', r.green_when, 'status', r.status, 'lanes', r.lanes)
                  ORDER BY r.rn)
 INTO v_rows FROM rows_ r;

 RETURN jsonb_build_object(
  'version', 'context-scorecard-v2', 'as_of', v_as_of, 'live_jobs', v_live_n, 'monitored_jobs', v_mon_n,
  'leads_not_followed_up', v_off_n,
  'scope', jsonb_build_object('rule', v_pol->'scope'->>'rule', 'live_jobs', v_live_n, 'monitored_jobs', v_mon_n,
   'leads_not_followed_up', v_off_n),
  'summary', jsonb_build_object(
    'done', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) r WHERE r->>'status' <> 'green'),
    'green', (SELECT count(*) FROM jsonb_array_elements(v_rows) r WHERE r->>'status' = 'green'),
    'amber', (SELECT count(*) FROM jsonb_array_elements(v_rows) r WHERE r->>'status' = 'amber'),
    'red', (SELECT count(*) FROM jsonb_array_elements(v_rows) r WHERE r->>'status' = 'red'),
    'red_rows', coalesce((SELECT jsonb_agg((r->>'row')::integer ORDER BY (r->>'row')::integer) FROM jsonb_array_elements(v_rows) r WHERE r->>'status' = 'red'), '[]'::jsonb),
    'red_lanes', coalesce((SELECT jsonb_agg((r->>'row') || ':' || (l->>'lane') ORDER BY (r->>'row')::integer, o)
                           FROM jsonb_array_elements(v_rows) r, jsonb_array_elements(r->'lanes') WITH ORDINALITY AS x(l, o)
                           WHERE l->>'status' = 'red'), '[]'::jsonb)),
  'rows', v_rows,
  'alarms', v_alarms,
  'per_job', jsonb_build_object('function', 'context_scorecard_jobs', 'scope', 'monitored live jobs', 'page_size', 150,
   'pages', ceil(v_mon_n / 150.0)),
  'policy', v_pol);
END
$fn$;
COMMENT ON FUNCTION public.context_scorecard(timestamptz) IS
 'Context scorecard v2 (20261007120000): the owner''s definition of done, rows 1 to 14 (context-scorecard-v2), on the new AI reader (the job ledger) and the live jobs the lead rule keeps monitored (context_lead_monitored_jobs; live_jobs, monitored_jobs and leads_not_followed_up on the card). Each row has lanes; each lane has status green, amber or red, the number, its unit and both thresholds (context_scorecard_policy); a row is its worst lane; every share is rounded down. Row 2 reads the stored stamps through context_party_roles_lanes; row 3 adds the placement grade per population (right_job_customer_facing, right_job_xero_and_quotes) and counts rows on a holding job as known misfiles; row 4 reads context_history_crm_summary (done = loaded or tried with no CRM contact) and the Xero top-up; row 6 counts an item read only when the job''s live ledger reading has read it; rows 7, 8 and 9 read the item kinds and the newest ledger, story and agent grades; row 10 adds context_scorecard_run_status''s hourly_run lane; row 14 adds the email reach. Alarms: lane_quiet and history_load_stalled. Rows SQL cannot measure are red with the reason. p_as_of cuts every business_events read and the lead rule; the CRM history and Xero top-up reads, the status functions and the grades'' reading status read the database as it is now. Read only; service role only; statement_timeout 50 s for API callers.';

-- 3. Per job: one page of the monitored live jobs, ordered by id.
CREATE OR REPLACE FUNCTION public.context_scorecard_jobs(p_after uuid DEFAULT NULL, p_limit integer DEFAULT 150,
 p_as_of timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET statement_timeout = '50s'
AS $fn$
DECLARE
 v_pol jsonb := public.context_scorecard_policy();
 v_as_of timestamptz := coalesce(p_as_of, now());
 v_limit integer := least(greatest(coalesce(p_limit, 150), 1), 300);
 v_ids uuid[];
 v_jobs jsonb;
BEGIN
 -- The page: monitored live jobs (the lead rule at the instant) after p_after.
 v_ids := ARRAY(SELECT m.job_id FROM public.context_lead_monitored_jobs(NULL, v_as_of) m
                WHERE m.monitored AND (p_after IS NULL OR m.job_id > p_after)
                ORDER BY m.job_id LIMIT v_limit);

 WITH pg AS (
  SELECT j.id, j.job_number, j.created_at,
         (nullif(btrim(j.ghl_contact_id), '') IS NOT NULL OR nullif(btrim(j.client_email), '') IS NOT NULL) AS identity
  FROM public.jobs j WHERE j.id = ANY (v_ids)
 ),
 ev AS (
  SELECT b.job_id,
         count(*) FILTER (WHERE m.msg) AS msgs,
         count(*) FILTER (WHERE m.msg AND coalesce(b.metadata->'party_roles'->>'sender_role', 'unknown') NOT IN ('unknown', '')
                            AND coalesce(b.metadata->'party_roles'->>'recipient_role', 'unknown') NOT IN ('unknown', '')) AS both_known,
         count(*) FILTER (WHERE b.source LIKE 'xero%' OR b.event_type LIKE 'invoice.%' OR b.event_type LIKE 'payment.%') AS xero_rows,
         min(coalesce(b.event_at, b.occurred_at)) FILTER (WHERE b.channel = 'email') AS first_email,
         min(coalesce(b.event_at, b.occurred_at)) FILTER (WHERE b.channel IN ('sms', 'call')) AS first_talk
  FROM public.business_events b
  CROSS JOIN LATERAL (SELECT public.context_scorecard_lane_of(b.event_type, b.source, b.channel, b.direction, b.body_preview, b.metadata)
                             IN ('texts', 'calls', 'call_transcripts', 'emails_in', 'emails_out', 'crew_staff_texts') AS msg) m
  WHERE b.job_id = ANY (v_ids) AND coalesce(b.context_captured_at, b.recorded_at) <= v_as_of
  GROUP BY b.job_id
 ),
 crm AS (  -- the CRM history read (monitored live jobs, as now)
  SELECT c.job_id, c.crm_state, c.reason FROM public.context_history_crm_jobs(v_ids) c
 ),
 xi AS (
  SELECT x.job_id, count(*) AS invoices FROM public.xero_invoices x
  WHERE x.job_id = ANY (v_ids) AND coalesce(x.status, '') NOT IN ('VOIDED', 'DELETED') AND coalesce(x.invoice_type, 'ACCREC') = 'ACCREC'
  GROUP BY x.job_id
 ),
 lr AS (   -- each job's live ledger reading at the instant
  SELECT DISTINCT ON (g.job_id) g.job_id, g.id, g.evidence_until
  FROM public.context_ledger_generations g
  WHERE g.job_id = ANY (v_ids) AND g.promoted_at IS NOT NULL AND g.promoted_at <= v_as_of
    AND (g.status = 'live' OR (g.status = 'retired' AND g.retired_at > v_as_of))
  ORDER BY g.job_id, g.promoted_at DESC, g.id
 ),
 cur AS (  -- the newest reading of any status, to name it when none is live
  SELECT DISTINCT ON (g.job_id) g.job_id, g.status
  FROM public.context_ledger_generations g
  WHERE g.job_id = ANY (v_ids) AND g.created_at <= v_as_of
  ORDER BY g.job_id, g.created_at DESC, g.id
 ),
 er AS (
  SELECT r.job_id, r.src_table, r.src_id, r.landed_at FROM public.context_ledger_evidence_rows(v_ids, v_as_of) r WHERE r.copy_of IS NULL
 ),
 un AS (   -- what the live reading has not read
  SELECT er.job_id,
         count(*) FILTER (WHERE x.live_mode) AS live_n,
         count(*) FILTER (WHERE x.live_mode AND er.landed_at < v_as_of - make_interval(mins => (v_pol->'reading'->>'live_max_minutes')::integer)) AS live_late,
         count(*) FILTER (WHERE NOT x.live_mode) AS backlog_n,
         min(er.landed_at) FILTER (WHERE NOT x.live_mode) AS backlog_oldest
  FROM er LEFT JOIN lr ON lr.job_id = er.job_id
  LEFT JOIN public.business_events b ON er.src_table = 'business_events' AND b.id = er.src_id
  CROSS JOIN LATERAL (SELECT CASE WHEN er.src_table = 'business_events'
                                  THEN coalesce(b.metadata->>'capture_mode', 'live') NOT IN ('backfill', 'relink') ELSE true END AS live_mode) x
  WHERE lr.evidence_until IS NULL OR er.landed_at > lr.evidence_until
  GROUP BY er.job_id
 ),
 ng AS (   -- the newest sample of each grade
  SELECT g.kind, g.sample_id FROM public.context_grades_newest(v_as_of) g WHERE g.sample_id IS NOT NULL
 ),
 gr AS (   -- this page's jobs in those samples: gated units and how many pass
  SELECT r.job_id, r.kind, min(r.sample_id) AS sample_id,
         count(*) FILTER (WHERE r.gated) AS units,
         count(*) FILTER (WHERE r.gated AND public.context_grade_passed(r.kind, r.unit, r.verdicts)) AS passed
  FROM public.context_grades r JOIN ng ON ng.kind = r.kind AND ng.sample_id = r.sample_id
  WHERE r.job_id = ANY (v_ids) AND r.created_at <= v_as_of
  GROUP BY r.job_id, r.kind
 ),
 tl AS (SELECT t.job_id, count(*) AS n FROM public.context_job_record_timeline(v_ids, v_as_of) t GROUP BY t.job_id),
 lp AS (SELECT l.job_id, count(*) FILTER (WHERE l.shown_as = 'loop') AS loops
        FROM public.context_job_record_loops(v_ids, v_as_of) l GROUP BY l.job_id),
 notes AS (SELECT lr.job_id, count(*) AS phase_notes
           FROM lr JOIN public.context_ledger_items i ON i.generation_id = lr.id AND i.item_type = 'phase_note' GROUP BY lr.job_id),
 np AS (SELECT f.job_id, f.needs_person FROM public.context_ledger_failures(v_ids) f),
 rch AS (  -- the deep email load's reach per job
  SELECT r.job_id, r.status, r.reason, r.reaches FROM public.context_email_history_reach_jobs(v_ids, v_as_of) r
 ),
 per AS (
  SELECT pg.id, pg.job_number,
   jsonb_build_array(
    -- Row 2: both sides named on every message on this job.
    jsonb_build_object('row', 2, 'number', CASE WHEN coalesce(ev.msgs, 0) = 0 THEN NULL ELSE trunc(100.0 * ev.both_known / ev.msgs, 1) END,
     'unit', '% of messages naming both sides',
     'status', CASE WHEN coalesce(ev.msgs, 0) = 0 THEN 'green'
                    WHEN 100.0 * ev.both_known / nullif(ev.msgs, 0) >= (v_pol->'who_to_whom'->>'green_pct')::numeric THEN 'green'
                    WHEN 100.0 * ev.both_known / nullif(ev.msgs, 0) >= (v_pol->'who_to_whom'->>'amber_pct')::numeric THEN 'amber' ELSE 'red' END,
     'value', coalesce(ev.both_known, 0) || ' of ' || coalesce(ev.msgs, 0) || ' messages'),
    -- Row 4: CRM history done (loaded, or tried with no CRM contact); Xero evidence when invoiced.
    jsonb_build_object('row', 4, 'number', NULL, 'unit', 'history loaded',
     'status', CASE WHEN (crm.job_id IS NOT NULL AND NOT crm.crm_state IN (SELECT jsonb_array_elements_text(v_pol->'history'->'crm_done_states')))
                         OR (coalesce(xi.invoices, 0) > 0 AND coalesce(ev.xero_rows, 0) = 0) THEN 'red'
                    WHEN crm.job_id IS NULL THEN 'amber' ELSE 'green' END,
     'value', CASE WHEN crm.job_id IS NULL THEN 'not in the CRM history read'
                   WHEN crm.crm_state = 'loaded' THEN 'CRM history loaded'
                   WHEN crm.crm_state = 'tried_no_contact' THEN 'CRM tried, no CRM contact (' || coalesce(crm.reason, '?') || ')'
                   ELSE 'CRM history missing (' || coalesce(crm.reason, '?') || ')' END
              || '; ' || CASE WHEN coalesce(xi.invoices, 0) = 0 THEN 'no live Xero invoice'
                              WHEN coalesce(ev.xero_rows, 0) = 0 THEN xi.invoices || ' Xero invoices, no Xero evidence'
                              ELSE xi.invoices || ' Xero invoices with evidence' END),
    -- Row 6: what the job's live ledger reading has not read.
    jsonb_build_object('row', 6, 'number', coalesce(un.live_late, 0), 'unit', 'live items unread by the live reading past the limit',
     'status', CASE WHEN coalesce(un.live_late, 0) > 0
                         OR un.backlog_oldest < v_as_of - make_interval(hours => (v_pol->'reading'->>'backlog_max_hours')::integer) THEN 'red'
                    WHEN coalesce(un.live_n, 0) + coalesce(un.backlog_n, 0) > 0 THEN 'amber' ELSE 'green' END,
     'value', coalesce(un.live_n, 0) || ' live and ' || coalesce(un.backlog_n, 0) || ' backlog items unread by the live reading'
              || CASE WHEN lr.job_id IS NULL THEN '; no live reading (ledger ' || coalesce(cur.status, 'none') || ')' ELSE '' END),
    -- Rows 11 to 13.
    jsonb_build_object('row', 11, 'number', coalesce(tl.n, 0), 'unit', 'record timeline rows',
     'status', CASE WHEN coalesce(tl.n, 0) >= (v_pol->'story'->>'timeline_min_rows')::integer AND lr.job_id IS NOT NULL
                         AND coalesce(notes.phase_notes, 0) > 0 THEN 'green' ELSE 'red' END,
     'value', coalesce(tl.n, 0) || ' timeline rows; ledger ' || CASE WHEN lr.job_id IS NOT NULL THEN 'live' ELSE coalesce(cur.status, 'none') END
              || ', ' || coalesce(notes.phase_notes, 0) || ' phase notes'),
    jsonb_build_object('row', 12, 'number', coalesce(lp.loops, 0), 'unit', 'record loops',
     'status', CASE WHEN lr.job_id IS NOT NULL THEN 'green' ELSE 'red' END,
     'value', coalesce(lp.loops, 0) || ' record loops; ledger ' || CASE WHEN lr.job_id IS NOT NULL THEN 'live' ELSE coalesce(cur.status, 'none') END
              || CASE WHEN coalesce(np.needs_person, false) THEN '; needs a person' ELSE '' END),
    jsonb_build_object('row', 13, 'number', CASE WHEN pg.identity THEN 1 ELSE 0 END, 'unit', 'client identity',
     'status', CASE WHEN pg.identity THEN 'green' ELSE 'red' END,
     'value', CASE WHEN pg.identity THEN 'CRM contact or client email' ELSE 'no CRM contact and no client email' END),
    -- Row 14: the email history reaches the job's start (the deep load), and its texts and calls do.
    jsonb_build_object('row', 14, 'number', NULL, 'unit', 'lanes reaching the job''s start',
     'status', CASE WHEN rch.status IN ('loading', 'short', 'not_started')
                         OR ev.first_talk > pg.created_at + make_interval(days => (v_pol->'depth'->>'start_days')::integer) THEN 'red'
                    WHEN rch.status IS NULL OR rch.status NOT IN ('reaches_start') THEN 'amber'
                    ELSE 'green' END,
     'value', 'job started ' || to_char((pg.created_at AT TIME ZONE 'Australia/Perth')::date, 'FMDD Mon YYYY')
              || '; email history reaches ' || coalesce(to_char((rch.reaches AT TIME ZONE 'Australia/Perth')::date, 'FMDD Mon YYYY'), 'nothing yet')
              || ' (' || coalesce(rch.status, 'not in the reach read') || coalesce(': ' || rch.reason, '') || ')'
              || '; earliest text or call ' || coalesce(to_char((ev.first_talk AT TIME ZONE 'Australia/Perth')::date, 'FMDD Mon YYYY'), 'none'))
   )
   -- Rows 7, 8 and 9, only on a job the newest sample of that grade graded.
   || coalesce((SELECT jsonb_agg(jsonb_build_object('row', CASE gr.kind WHEN 'ledger' THEN 7 WHEN 'story' THEN 8 ELSE 9 END,
          'number', gr.passed,
          'unit', CASE gr.kind WHEN 'ledger' THEN 'ledger items passing the grade' WHEN 'story' THEN 'story card passing the grade'
                  ELSE 'agent calls passing the grade' END,
          'status', CASE WHEN gr.passed = gr.units THEN 'green' ELSE 'red' END,
          'value', gr.passed || ' of ' || gr.units || ' pass (sample ' || gr.sample_id || ')')
         ORDER BY CASE gr.kind WHEN 'ledger' THEN 7 WHEN 'story' THEN 8 ELSE 9 END)
       FROM gr WHERE gr.job_id = pg.id AND gr.units > 0), '[]'::jsonb) AS rows_
  FROM pg LEFT JOIN ev ON ev.job_id = pg.id LEFT JOIN crm ON crm.job_id = pg.id LEFT JOIN xi ON xi.job_id = pg.id
  LEFT JOIN lr ON lr.job_id = pg.id LEFT JOIN cur ON cur.job_id = pg.id LEFT JOIN un ON un.job_id = pg.id
  LEFT JOIN tl ON tl.job_id = pg.id LEFT JOIN lp ON lp.job_id = pg.id LEFT JOIN notes ON notes.job_id = pg.id
  LEFT JOIN np ON np.job_id = pg.id LEFT JOIN rch ON rch.job_id = pg.id
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('job_id', p.id, 'job_number', p.job_number,
          'status', CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(p.rows_) r WHERE r->>'status' = 'red') THEN 'red'
                         WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(p.rows_) r WHERE r->>'status' = 'amber') THEN 'amber' ELSE 'green' END,
          'red_rows', coalesce((SELECT jsonb_agg((r->>'row')::integer ORDER BY (r->>'row')::integer) FROM jsonb_array_elements(p.rows_) r
                                WHERE r->>'status' = 'red'), '[]'::jsonb),
          'rows', (SELECT jsonb_agg(r ORDER BY (r->>'row')::integer) FROM jsonb_array_elements(p.rows_) r)) ORDER BY p.id), '[]'::jsonb)
 INTO v_jobs FROM per p;

 RETURN jsonb_build_object('version', 'context-scorecard-jobs-v2', 'as_of', v_as_of,
  'scope', 'monitored live jobs (context_lead_monitored_jobs)',
  'rows_measured', jsonb_build_array(2, 4, 6, 11, 12, 13, 14),
  'sampled_rows', jsonb_build_array(7, 8, 9),
  'jobs', v_jobs,
  'next', CASE WHEN cardinality(v_ids) = v_limit THEN v_ids[v_limit] END);
END
$fn$;
COMMENT ON FUNCTION public.context_scorecard_jobs(uuid, integer, timestamptz) IS
 'Context scorecard v2 (20261007120000): per-job rows of the done definition for one page of the monitored live jobs (context_lead_monitored_jobs at p_as_of) ordered by id after p_after (at most 300, default 150). Rows measured on every job: 2 (both sides named), 4 (CRM history done, loaded or tried with no CRM contact, from context_history_crm_jobs; Xero evidence when invoiced), 6 (items the job''s live ledger reading has not read: live past 2 hours, the backlog past 24 hours), 11 (timeline plus a live ledger with phase notes), 12 (a live ledger), 13 (client identity), 14 (the email history reaches the job''s start, context_email_history_reach_jobs, and its texts and calls do). Rows 7, 8 and 9 appear only on a job the newest ledger, story or agent grade graded (its units passing context_grade_passed). Each row green, amber or red; a job is its worst row. p_as_of cuts the evidence and the lead rule; the CRM read and the grades'' reading status are read as now. next = the cursor for the following page, null at the end. Read only; service role only; statement_timeout 50 s for API callers.';

-- 4. Access: service role only (unchanged).
REVOKE ALL ON FUNCTION public.context_scorecard_policy() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_scorecard(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_scorecard_jobs(uuid, integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_scorecard_policy() TO service_role;
GRANT EXECUTE ON FUNCTION public.context_scorecard(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_scorecard_jobs(uuid, integer, timestamptz) TO service_role;
