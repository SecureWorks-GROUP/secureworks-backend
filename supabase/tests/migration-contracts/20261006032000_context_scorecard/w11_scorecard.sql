-- The 20261006032000 (W11) bodies of context_scorecard_policy(),
-- context_scorecard(timestamptz) and context_scorecard_jobs(uuid, integer,
-- timestamptz), word for word with their comments, so a contract can stand
-- them back up inside its rolled-back transaction after the scorecard v2
-- (20261007120000) replaced them: W11's own contract, and the hourly run's
-- rollback proof (20261007040000), whose rollback refuses while the live
-- scorecard reads context_scorecard_run_status. md5(prosrc)
-- 50ed8ccdac924097399359a9857f02a8, 82574dfb65328d855ad87683a78ca9cd and
-- 6fd07f87b10ff8e0164f2daad98cce48 (production's before v2). Not a migration.
CREATE OR REPLACE FUNCTION public.context_scorecard_policy()
RETURNS jsonb
LANGUAGE sql IMMUTABLE
AS $fn$
 SELECT jsonb_build_object(
  'version', 'context-scorecard-v1',
  -- A job is live unless its status is one of these (done definition, 5 Oct).
  'live_excluded_statuses', jsonb_build_array('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost'),
  -- Event lanes (rows 1, 2, 3) look back this many days from as_of.
  'window_days', 30,
  -- Row 1 and the lane_quiet alarm. For each capture lane: amber once the
  -- newest live item (capture_mode live, not backfill or relink) is older than
  -- warn_after working minutes; red, and the lane_quiet alarm, once older than
  -- alarm_after working minutes. Owner's 6 Oct asks: texts 2 h, email 1 h,
  -- Xero 24 h (one Perth working day is 660 working minutes, 07:00 to 18:00).
  -- The rest are set from measured volume on Mon 5 Oct (texts 156, calls 76,
  -- emails in 59, emails out 43, quotes 17, documents 22, crew texts 7,
  -- bookings 3 in the working day).
  'lane_quiet', jsonb_build_object(
   'texts',            jsonb_build_object('label', 'texts', 'ord', 1,  'warn_after', 60,  'alarm_after', 120),   -- 2 working hours
   'calls',            jsonb_build_object('label', 'calls', 'ord', 2,  'warn_after', 60,  'alarm_after', 120),   -- 2 working hours
   'call_transcripts', jsonb_build_object('label', 'call transcripts', 'ord', 3,  'warn_after', 90,  'alarm_after', 180),   -- 3 working hours (follow their calls)
   'emails_in',        jsonb_build_object('label', 'incoming emails', 'ord', 4,  'warn_after', 30,  'alarm_after', 60),    -- 1 working hour
   'emails_out',       jsonb_build_object('label', 'outgoing emails', 'ord', 5,  'warn_after', 60,  'alarm_after', 120),   -- 2 working hours
   'xero',             jsonb_build_object('label', 'Xero invoices or payments', 'ord', 6,  'warn_after', 330, 'alarm_after', 660),   -- one working day (the "24 h" ask)
   'quotes',           jsonb_build_object('label', 'quotes', 'ord', 7,  'warn_after', 330, 'alarm_after', 660),   -- one working day
   'bookings',         jsonb_build_object('label', 'bookings or calendar items', 'ord', 8,  'warn_after', 660, 'alarm_after', 1320),  -- two working days
   'documents',        jsonb_build_object('label', 'documents', 'ord', 9,  'warn_after', 330, 'alarm_after', 660),   -- one working day
   'crew_staff_texts', jsonb_build_object('label', 'crew or staff texts', 'ord', 10, 'warn_after', 660, 'alarm_after', 1320)), -- two working days
  -- Row 4 and the history_load_stalled alarm: a history load (a capture run
  -- source naming history or backfill, dry runs aside) whose last this-many
  -- finished runs were all partial (more to do), made no progress and left the
  -- cursor where it was.
  'history_stall_runs', 3,
  -- Progress is any of these run counters above zero, whichever the load
  -- writes: rows added or upgraded (the mail and CRM loads), contacts finished
  -- (the CRM load), jobs linked or attempts recorded (the CRM link pass, which
  -- keeps one cursor on every run, so its cursor never shows progress).
  'history_progress_keys', jsonb_build_array('inserted', 'upgraded', 'contacts_done', 'linked', 'attempts_recorded'),
  -- Row 4: the cron job that keeps each history load running daily. null = no
  -- job is known for that load, which reads red until one exists.
  'history_schedules', jsonb_build_object('ghl', 'ghl-history-schedule', 'email', 'outlook-mail-poll', 'xero', NULL),
  -- Row 2: share of messages naming both sender and recipient role.
  'who_to_whom', jsonb_build_object('green_pct', 95, 'amber_pct', 80),
  -- Row 2: crew and staff texts are counted from the internal-text rule's start.
  'crew_rule_since', '2026-10-04T22:31:00Z',
  -- Row 3: share placed on a job (customer-facing; Xero and quotes).
  'placement', jsonb_build_object('green_pct', 95, 'amber_pct', 80),
  -- Row 3: share of review-queue items that carry a candidate job.
  'review_queue', jsonb_build_object('green_pct', 95, 'amber_pct', 50),
  -- Row 4: share of live jobs with their history loaded (CRM, email sources, Xero).
  'history', jsonb_build_object('green_pct', 95, 'amber_pct', 50),
  -- Row 5: share of documents with readable text.
  'documents', jsonb_build_object('green_pct', 95, 'amber_pct', 70),
  -- Row 6: a live-captured row must be read within live_max_minutes (wall
  -- clock); a backfill row unread longer than backlog_max_hours turns the
  -- backlog red ("0 each morning"); failed reads today above failed_amber_pct
  -- of the day's runs turn red.
  'reading', jsonb_build_object('live_max_minutes', 120, 'backlog_max_hours', 24, 'failed_amber_pct', 10),
  -- Row 7: share of live jobs with evidence that carry a current fact.
  'facts', jsonb_build_object('green_pct', 95, 'amber_pct', 50),
  -- Row 8: the brief's flag, and the share of live jobs with facts that carry a brief.
  'brief', jsonb_build_object('flag', 'context_job_brief_v1', 'green_pct', 95),
  -- Rows 11 to 13: share of live jobs; a story needs at least this many record timeline rows.
  'story', jsonb_build_object('green_pct', 95, 'amber_pct', 50, 'timeline_min_rows', 2),
  -- Row 14: a lane reaches a job's start when its earliest item is within
  -- start_days of the job's created date; share of live jobs that have that lane.
  'depth', jsonb_build_object('start_days', 7, 'green_pct', 95, 'amber_pct', 80)
 )
$fn$;
COMMENT ON FUNCTION public.context_scorecard_policy() IS
 'Context scorecard (20261006032000): every threshold the scorecard grades against, in one place (lane quiet minutes in Perth working time, percentages, the history stall rule, the cron jobs that keep history loads daily). Changed only by migration.';

CREATE OR REPLACE FUNCTION public.context_scorecard(p_as_of timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE
 v_pol jsonb := public.context_scorecard_policy();
 v_as_of timestamptz := coalesce(p_as_of, now());
 v_from timestamptz;
 v_live uuid[];
 v_live_n integer;
 v_lanes jsonb := '[]'::jsonb;   -- one object per lane; statuses are graded at the end
 v_alarms jsonb := '[]'::jsonb;
 v_ev jsonb;                      -- per-lane aggregates over the window
 v_q record; v_r record; v_x record;
 v_newest timestamptz; v_quiet integer; v_n numeric; v_d numeric; v_txt text;
 v_fresh jsonb; v_ecap jsonb; v_gcap jsonb; v_tcap jsonb; v_dt jsonb; v_vs jsonb; v_gh jsonb; v_eh jsonb;
 v_keys text; v_missing text[]; v_rows jsonb;
BEGIN
 v_from := v_as_of - make_interval(days => (v_pol->>'window_days')::integer);
 v_live := ARRAY(SELECT jb.id FROM public.jobs jb
                 WHERE jb.status::text <> ALL (ARRAY(SELECT jsonb_array_elements_text(v_pol->'live_excluded_statuses')))
                 ORDER BY jb.id);
 v_live_n := cardinality(v_live);

 v_fresh := public.context_source_freshness();
 v_ecap := public.context_email_capture_status();
 v_gcap := public.context_ghl_capture_status();
 v_tcap := public.context_transcript_capture_status();
 v_dt := public.context_document_text_status();
 v_vs := public.context_document_vision_status();
 v_gh := public.context_ghl_history_progress();
 v_eh := public.context_email_history_status();

 -- One pass over the window: per lane, the newest live item, who-to-whom and placement.
 SELECT coalesce(jsonb_object_agg(a.lane, to_jsonb(a) - 'lane'), '{}'::jsonb) INTO v_ev
 FROM (
  SELECT e.lane,
         max(e.cap) FILTER (WHERE e.live_mode) AS newest_live,
         count(*) FILTER (WHERE e.live_mode AND e.cap > v_as_of - interval '24 hours') AS live_24h,
         count(*) AS n,
         count(*) FILTER (WHERE e.pr IS NOT NULL) AS stamped,
         count(*) FILTER (WHERE coalesce(e.pr->>'sender_role', 'unknown') NOT IN ('unknown', '')
                            AND coalesce(e.pr->>'recipient_role', 'unknown') NOT IN ('unknown', '')) AS both_known,
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

 ---------------------------------------------------------------------------
 -- Row 1. Capture: every lane live, and an alarm when a lane goes quiet.
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
 -- The capture status functions' own alarms (sources, mail polls, webhooks, transcripts).
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
 -- Row 2. Who-to-whom: both roles on every message; crew texts stay on their job, internal.
 FOR v_txt IN SELECT unnest(ARRAY['texts', 'calls', 'call_transcripts', 'emails_in', 'emails_out']) LOOP
  v_n := (v_ev->v_txt->>'n')::numeric;
  v_d := (v_ev->v_txt->>'both_known')::numeric;
  v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 2, 'lane', v_txt,
   'number', CASE WHEN coalesce(v_n, 0) = 0 THEN NULL ELSE round(100.0 * v_d / v_n, 1) END, 'unit', '% of messages naming both sides',
   'green', (v_pol->'who_to_whom'->>'green_pct')::numeric, 'amber', (v_pol->'who_to_whom'->>'amber_pct')::numeric, 'higher_is_better', true,
   'status', CASE WHEN coalesce(v_n, 0) = 0 THEN 'green' END,
   'value', coalesce(v_d, 0) || ' of ' || coalesce(v_n, 0) || ' messages in ' || (v_pol->>'window_days') || ' days name both sides',
   'note', coalesce(v_n - (v_ev->v_txt->>'stamped')::numeric, 0) || ' carry no party roles'));
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
        coalesce(sum((v_ev->l->>'n')::numeric), 0) AS msgs, coalesce(sum((v_ev->l->>'placed')::numeric), 0) AS placed
 INTO v_q FROM unnest(ARRAY['texts', 'calls', 'call_transcripts', 'emails_in', 'emails_out']) l;
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 3, 'lane', 'customer_facing',
  'number', CASE WHEN v_q.cust = 0 THEN NULL ELSE round(100.0 * v_q.cust_placed / v_q.cust, 1) END,
  'unit', '% of customer messages on a job', 'green', (v_pol->'placement'->>'green_pct')::numeric,
  'amber', (v_pol->'placement'->>'amber_pct')::numeric, 'higher_is_better', true,
  'status', CASE WHEN v_q.cust = 0 THEN 'green' END,
  'value', v_q.cust_placed || ' of ' || v_q.cust || ' customer messages in ' || (v_pol->>'window_days') || ' days are on a job',
  'note', 'placed share, an upper bound on right-job accuracy; all messages: ' || v_q.placed || ' of ' || v_q.msgs || ' on a job'));
 v_n := coalesce((v_ev->'xero'->>'n')::numeric, 0) + coalesce((v_ev->'quotes'->>'n')::numeric, 0);
 v_d := coalesce((v_ev->'xero'->>'placed')::numeric, 0) + coalesce((v_ev->'quotes'->>'placed')::numeric, 0);
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 3, 'lane', 'xero_and_quotes',
  'number', CASE WHEN v_n = 0 THEN NULL ELSE round(100.0 * v_d / v_n, 1) END, 'unit', '% of Xero and quote items on a job',
  'green', (v_pol->'placement'->>'green_pct')::numeric, 'amber', (v_pol->'placement'->>'amber_pct')::numeric, 'higher_is_better', true,
  'status', CASE WHEN v_n = 0 THEN 'green' END,
  'value', v_d || ' of ' || v_n || ' Xero and quote items in ' || (v_pol->>'window_days') || ' days are on a job', 'note', 'placed share'));
 SELECT count(*) AS queued, count(*) FILTER (WHERE cardinality(b.candidate_job_ids) > 0) AS with_candidate INTO v_x
 FROM public.business_events b
 WHERE coalesce(b.context_captured_at, b.recorded_at) > v_from AND coalesce(b.context_captured_at, b.recorded_at) <= v_as_of
   AND b.job_id IS NULL AND b.attribution_status IN ('admin_bucket', 'unplaced', 'pending_luna', 'review');
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 3, 'lane', 'review_queue',
  'number', CASE WHEN v_x.queued = 0 THEN NULL ELSE round(100.0 * v_x.with_candidate / v_x.queued, 1) END,
  'unit', '% of unplaced items with a candidate job', 'green', (v_pol->'review_queue'->>'green_pct')::numeric,
  'amber', (v_pol->'review_queue'->>'amber_pct')::numeric, 'higher_is_better', true,
  'status', CASE WHEN v_x.queued = 0 THEN 'green' END,
  'value', v_x.with_candidate || ' of ' || v_x.queued || ' unplaced items in ' || (v_pol->>'window_days') || ' days have a candidate job',
  'note', 'admin_bucket, unplaced, pending_luna and review rows with no job'));
 SELECT count(*), count(*) FILTER (WHERE m.class = 'repoint') INTO v_n, v_d FROM public.context_payload_job_mismatch_rows() m;
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 3, 'lane', 'known_misfiles',
  'number', v_n, 'unit', 'rows on a job other than the one they name', 'green', 0, 'amber', 0, 'higher_is_better', false,
  'value', v_n || ' mismatched (' || v_d || ' the repair can move)', 'note', 'context_payload_job_mismatch_rows (read only)'));
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 3, 'lane', 'right_job_accuracy',
  'number', NULL, 'unit', '% right on a graded sample', 'green', 95, 'amber', NULL, 'higher_is_better', true, 'status', 'red',
  'value', 'not measurable yet', 'note', 'no graded placement sample is stored in the database'));

 ---------------------------------------------------------------------------
 -- Row 4. History: loaded for every live job, loads running daily until complete.
 SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.context_ghl_history_contacts h WHERE h.status = 'done' AND j.id = ANY (h.job_ids))),
        count(*) FILTER (WHERE nullif(btrim(j.ghl_contact_id), '') IS NULL)
 INTO v_n, v_d FROM public.jobs j WHERE j.id = ANY (v_live);
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 4, 'lane', 'ghl_history',
  'number', CASE WHEN v_live_n = 0 THEN NULL ELSE round(100.0 * v_n / v_live_n, 1) END, 'unit', '% of live jobs with CRM history loaded',
  'green', (v_pol->'history'->>'green_pct')::numeric, 'amber', (v_pol->'history'->>'amber_pct')::numeric, 'higher_is_better', true,
  'status', CASE WHEN v_live_n = 0 THEN 'green' END,
  'value', v_n || ' of ' || v_live_n || ' live jobs have their CRM texts, calls and emails loaded',
  'note', v_d || ' live jobs have no CRM contact; load scope ' || coalesce(v_gh->>'live_jobs', '?') || ' jobs, not started '
          || coalesce(v_gh->>'history_not_started', '?') || ', failed ' || coalesce(v_gh->>'history_failed', '?')));
 v_n := coalesce((v_eh->>'sources')::numeric, 0);
 v_d := coalesce((v_eh->'by_state'->>'succeeded')::numeric, 0);
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 4, 'lane', 'email_history',
  'number', CASE WHEN v_n = 0 THEN NULL ELSE round(100.0 * v_d / v_n, 1) END, 'unit', '% of mailbox sources with history finished',
  'green', (v_pol->'history'->>'green_pct')::numeric, 'amber', (v_pol->'history'->>'amber_pct')::numeric, 'higher_is_better', true,
  'value', v_d || ' of ' || v_n || ' mailbox sources finished',
  'note', coalesce((SELECT string_agg(s.key || ' ' || s.value, ', ' ORDER BY s.key COLLATE "C") FROM jsonb_each_text(v_eh->'by_state') s), 'no plan')));
 SELECT count(DISTINCT x.job_id), count(DISTINCT x.job_id) FILTER (WHERE EXISTS (
          SELECT 1 FROM public.business_events b WHERE b.job_id = x.job_id AND coalesce(b.context_captured_at, b.recorded_at) <= v_as_of
            AND (b.source LIKE 'xero%' OR b.event_type LIKE 'invoice.%' OR b.event_type LIKE 'payment.%')))
 INTO v_n, v_d
 FROM public.xero_invoices x
 WHERE x.job_id = ANY (v_live) AND coalesce(x.status, '') NOT IN ('VOIDED', 'DELETED') AND coalesce(x.invoice_type, 'ACCREC') = 'ACCREC';
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 4, 'lane', 'xero_history',
  'number', CASE WHEN v_n = 0 THEN NULL ELSE round(100.0 * v_d / v_n, 1) END, 'unit', '% of invoiced live jobs with Xero evidence',
  'green', (v_pol->'history'->>'green_pct')::numeric, 'amber', (v_pol->'history'->>'amber_pct')::numeric, 'higher_is_better', true,
  'status', CASE WHEN v_n = 0 THEN 'green' END,
  'value', v_d || ' of ' || v_n || ' live jobs with a live Xero invoice carry Xero evidence', 'note', 'invoices not voided or deleted'));
 -- History loads that stopped moving: the last N finished runs all partial, no progress counter above zero
 -- (context_scorecard_policy().history_progress_keys), cursor unchanged.
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
  'higher_is_better', false, 'value', v_n || ' stalled' || coalesce(': ' || array_to_string(v_missing, ', '), ''),
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
  'note', 'cron job names in context_scorecard_policy().history_schedules'));

 ---------------------------------------------------------------------------
 -- Row 5. Documents.
 v_n := coalesce((v_dt->'documents'->>'total')::numeric, 0);
 v_d := coalesce((v_dt->'documents'->>'with_text')::numeric, 0);
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 5, 'lane', 'document_text',
  'number', CASE WHEN v_n = 0 THEN NULL ELSE round(100.0 * v_d / v_n, 1) END, 'unit', '% of documents with readable text',
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
 -- Row 6. Reading: every placed item read within 2 hours; backlog 0 each morning.
 SELECT count(*) FILTER (WHERE u.live_mode) AS live_n,
        count(*) FILTER (WHERE u.live_mode AND u.cap < v_as_of - make_interval(mins => (v_pol->'reading'->>'live_max_minutes')::integer)) AS live_late,
        min(u.cap) FILTER (WHERE u.live_mode) AS live_oldest,
        count(*) FILTER (WHERE NOT u.live_mode) AS backlog_n, count(DISTINCT u.job_id) FILTER (WHERE NOT u.live_mode) AS backlog_jobs,
        min(u.cap) FILTER (WHERE NOT u.live_mode) AS backlog_oldest
 INTO v_x
 FROM (SELECT r.job_id, coalesce(r.context_captured_at, r.recorded_at) AS cap,
              coalesce(r.metadata->>'capture_mode', 'live') NOT IN ('backfill', 'relink') AS live_mode
       FROM public.context_unread_rows(v_live) r) u
 WHERE u.cap <= v_as_of;
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 6, 'lane', 'live_unread',
  'number', v_x.live_late, 'unit', 'live items unread for more than ' || (v_pol->'reading'->>'live_max_minutes') || ' minutes',
  'green', 0, 'amber', 0, 'higher_is_better', false,
  'value', v_x.live_late || ' late of ' || v_x.live_n || ' live items unread'
           || coalesce('; oldest ' || round(extract(epoch FROM v_as_of - v_x.live_oldest) / 3600.0, 1) || ' h', ''),
  'note', 'context_unread_rows on live jobs, capture_mode live'));
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 6, 'lane', 'backlog_unread',
  'number', v_x.backlog_n, 'unit', 'backfill and relinked items unread on live jobs', 'green', 0, 'amber', NULL, 'higher_is_better', false,
  'status', CASE WHEN v_x.backlog_n = 0 THEN 'green'
                 WHEN v_x.backlog_oldest >= v_as_of - make_interval(hours => (v_pol->'reading'->>'backlog_max_hours')::integer) THEN 'amber'
                 ELSE 'red' END,
  'value', v_x.backlog_n || ' rows on ' || v_x.backlog_jobs || ' jobs'
           || coalesce('; oldest ' || round(extract(epoch FROM v_as_of - v_x.backlog_oldest) / 3600.0, 1) || ' h', ''),
  'note', 'red once a backlog row has waited more than ' || (v_pol->'reading'->>'backlog_max_hours') || ' h'));
 SELECT count(*), count(*) FILTER (WHERE r.status = 'failed') INTO v_n, v_d
 FROM public.context_extraction_runs r
 WHERE r.phase = 'extraction' AND r.run_date = (v_as_of AT TIME ZONE 'Australia/Perth')::date AND r.started_at <= v_as_of;
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 6, 'lane', 'failed_reads_today',
  'number', CASE WHEN v_n = 0 THEN 0 ELSE round(100.0 * v_d / v_n, 1) END, 'unit', '% of today''s reads that failed (Perth day)',
  'green', 0, 'amber', (v_pol->'reading'->>'failed_amber_pct')::numeric, 'higher_is_better', false,
  'value', v_d || ' failed of ' || v_n || ' reads today', 'note', 'context_extraction_runs, phase extraction'));

 ---------------------------------------------------------------------------
 -- Row 7. Facts.
 SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.business_events b WHERE b.job_id = j.id
                                         AND coalesce(b.context_captured_at, b.recorded_at) <= v_as_of)),
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.business_events b WHERE b.job_id = j.id
                                         AND coalesce(b.context_captured_at, b.recorded_at) <= v_as_of)
                           AND EXISTS (SELECT 1 FROM public.current_job_context_facts f WHERE f.job_id = j.id AND f.kind <> 'job_brief'))
 INTO v_n, v_d FROM public.jobs j WHERE j.id = ANY (v_live);
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 7, 'lane', 'fact_coverage',
  'number', CASE WHEN v_n = 0 THEN NULL ELSE round(100.0 * v_d / v_n, 1) END, 'unit', '% of live jobs with evidence that carry a current fact',
  'green', (v_pol->'facts'->>'green_pct')::numeric, 'amber', (v_pol->'facts'->>'amber_pct')::numeric, 'higher_is_better', true,
  'status', CASE WHEN v_n = 0 THEN 'green' END,
  'value', v_d || ' of ' || v_n || ' live jobs with evidence carry a current fact', 'note', 'job_brief facts not counted'));
 v_lanes := v_lanes || jsonb_build_array(
  jsonb_build_object('row', 7, 'lane', 'fact_catalogue', 'number', NULL, 'unit', 'published catalogue of fact kinds', 'green', NULL,
   'amber', NULL, 'higher_is_better', true, 'status', 'red', 'value', 'not measurable yet', 'note', 'no catalogue table is published'),
  jsonb_build_object('row', 7, 'lane', 'fact_grade', 'number', NULL, 'unit', '% of facts passed by an independent grader (10-job sample)',
   'green', 95, 'amber', NULL, 'higher_is_better', true, 'status', 'red', 'value', 'not measurable yet',
   'note', 'no grade table is stored in the database'));

 ---------------------------------------------------------------------------
 -- Row 8. Job answer.
 SELECT count(DISTINCT f.job_id) FILTER (WHERE f.kind = 'job_brief'), count(DISTINCT f.job_id)
 INTO v_d, v_n FROM public.current_job_context_facts f WHERE f.job_id = ANY (v_live);
 v_txt := CASE WHEN EXISTS (SELECT 1 FROM public.feature_flags ff WHERE ff.flag_name = v_pol->'brief'->>'flag' AND ff.enabled) THEN 'on' ELSE 'off' END;
 v_lanes := v_lanes || jsonb_build_array(
  jsonb_build_object('row', 8, 'lane', 'brief', 'number', CASE WHEN v_n = 0 THEN NULL ELSE round(100.0 * v_d / v_n, 1) END,
   'unit', '% of live jobs with facts that carry a brief', 'green', (v_pol->'brief'->>'green_pct')::numeric, 'amber', NULL,
   'higher_is_better', true,
   'status', CASE WHEN v_txt = 'off' THEN 'red'
                  WHEN coalesce(100.0 * v_d / nullif(v_n, 0), 0) >= (v_pol->'brief'->>'green_pct')::numeric THEN 'green' ELSE 'amber' END,
   'value', 'brief flag ' || v_txt || '; ' || v_d || ' of ' || v_n || ' live jobs with facts carry a brief',
   'note', 'the brief is switched on only after a 6 of 6 grade'),
  jsonb_build_object('row', 8, 'lane', 'answer_grade', 'number', NULL, 'unit', 'correct on a 10-job graded sample', 'green', NULL,
   'amber', NULL, 'higher_is_better', true, 'status', 'red', 'value', 'not measurable yet', 'note', 'no graded sample is stored in the database'));

 ---------------------------------------------------------------------------
 -- Row 9. Agent use (and 9+, the story test).
 v_lanes := v_lanes || jsonb_build_array(
  jsonb_build_object('row', 9, 'lane', 'agent_test', 'number', NULL, 'unit', 'correct on the 10-job test set (where at, last told, owed)',
   'green', NULL, 'amber', NULL, 'higher_is_better', true, 'status', 'red', 'value', 'not measurable yet', 'note', 'no agent test results are stored'),
  jsonb_build_object('row', 9, 'lane', 'story_test', 'number', NULL, 'unit', 'correct on "tell me the story of this job and what is outstanding"',
   'green', NULL, 'amber', NULL, 'higher_is_better', true, 'status', 'red', 'value', 'not measurable yet', 'note', 'row 9+; no answer key is stored'));

 ---------------------------------------------------------------------------
 -- Row 10. Health.
 v_lanes := v_lanes || jsonb_build_array(
  jsonb_build_object('row', 10, 'lane', 'scorecard', 'number', 1, 'unit', 'one scorecard read for rows 1 to 14, per lane and per job',
   'green', 1, 'amber', NULL, 'higher_is_better', true, 'status', 'green', 'value', 'context_scorecard and context_scorecard_jobs answer',
   'note', 'this read'),
  jsonb_build_object('row', 10, 'lane', 'hourly_run', 'number', NULL, 'unit', 'run hourly, red rows reported', 'green', NULL, 'amber', NULL,
   'higher_is_better', true, 'status', 'red', 'value', 'not measurable here',
   'note', 'the hourly run and its red-row report happen outside the database; no run record is stored'));

 ---------------------------------------------------------------------------
 -- Rows 11 to 13. Story, open loops, client view (PR 972's ledger and record layer).
 IF to_regclass('public.context_ledger_generations') IS NOT NULL AND to_regprocedure('public.context_job_record_timeline(uuid[],timestamptz)') IS NOT NULL THEN
  SELECT count(*) AS live_ledger,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.context_ledger_items i WHERE i.generation_id = g.id AND i.item_type = 'phase_note')) AS with_notes,
         array_agg(g.job_id) FILTER (WHERE EXISTS (SELECT 1 FROM public.context_ledger_items i WHERE i.generation_id = g.id AND i.item_type = 'phase_note')) AS ids
  INTO v_x FROM public.context_ledger_generations g WHERE g.job_id = ANY (v_live) AND g.status = 'live';
  -- The record timeline is read only for jobs that already pass the ledger half.
  SELECT count(*) INTO v_n FROM (
   SELECT t.job_id FROM public.context_job_record_timeline(coalesce(v_x.ids, '{}'::uuid[]), v_as_of) t
   GROUP BY t.job_id HAVING count(*) >= (v_pol->'story'->>'timeline_min_rows')::integer) s;
  v_lanes := v_lanes || jsonb_build_array(
   jsonb_build_object('row', 11, 'lane', 'job_story', 'number', CASE WHEN v_live_n = 0 THEN NULL ELSE round(100.0 * v_n / v_live_n, 1) END,
    'unit', '% of live jobs with a timeline and a live ledger with phase notes', 'green', (v_pol->'story'->>'green_pct')::numeric,
    'amber', (v_pol->'story'->>'amber_pct')::numeric, 'higher_is_better', true, 'status', CASE WHEN v_live_n = 0 THEN 'green' END,
    'value', v_n || ' of ' || v_live_n || ' live jobs; ' || v_x.with_notes || ' have a live ledger with phase notes',
    'note', 'per job: context_scorecard_jobs (row11 of context_story_scorecard_jobs)'),
   jsonb_build_object('row', 12, 'lane', 'open_loops', 'number', CASE WHEN v_live_n = 0 THEN NULL ELSE round(100.0 * v_x.live_ledger / v_live_n, 1) END,
    'unit', '% of live jobs with a live ledger (promises and asks come from the words)', 'green', (v_pol->'story'->>'green_pct')::numeric,
    'amber', (v_pol->'story'->>'amber_pct')::numeric, 'higher_is_better', true, 'status', CASE WHEN v_live_n = 0 THEN 'green' END,
    'value', v_x.live_ledger || ' of ' || v_live_n || ' live jobs have a live ledger',
    'note', 'record loops (money owed, dates) are built for every job; the ledger adds what was promised and asked'));
 ELSE
  v_lanes := v_lanes || jsonb_build_array(
   jsonb_build_object('row', 11, 'lane', 'job_story', 'number', NULL, 'unit', '% of live jobs with a story', 'green', NULL, 'amber', NULL,
    'higher_is_better', true, 'status', 'red', 'value', 'not deployed', 'note', 'the ledger and record layer (PR 972) are not on this database'),
   jsonb_build_object('row', 12, 'lane', 'open_loops', 'number', NULL, 'unit', '% of live jobs with open loops', 'green', NULL, 'amber', NULL,
    'higher_is_better', true, 'status', 'red', 'value', 'not deployed', 'note', 'the ledger and record layer (PR 972) are not on this database'));
 END IF;
 SELECT count(*) FILTER (WHERE nullif(btrim(j.ghl_contact_id), '') IS NOT NULL OR nullif(btrim(j.client_email), '') IS NOT NULL)
 INTO v_n FROM public.jobs j WHERE j.id = ANY (v_live);
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 13, 'lane', 'client_identity',
  'number', CASE WHEN v_live_n = 0 THEN NULL ELSE round(100.0 * v_n / v_live_n, 1) END,
  'unit', '% of live jobs that can be matched to their client', 'green', (v_pol->'story'->>'green_pct')::numeric,
  'amber', (v_pol->'story'->>'amber_pct')::numeric, 'higher_is_better', true,
  'status', CASE WHEN to_regprocedure('public.context_client_story(uuid,timestamptz)') IS NULL THEN 'red' WHEN v_live_n = 0 THEN 'green' END,
  'value', v_n || ' of ' || v_live_n || ' live jobs have a CRM contact or a client email',
  'note', CASE WHEN to_regprocedure('public.context_client_story(uuid,timestamptz)') IS NULL THEN 'the client view (PR 972) is not on this database'
               ELSE 'the client view groups jobs by CRM contact, else exact client email' END));

 ---------------------------------------------------------------------------
 -- Row 14. History depth: every lane back to each live job's start.
 SELECT count(*) FILTER (WHERE s.first_email IS NOT NULL) AS email_jobs,
        count(*) FILTER (WHERE s.first_email <= s.created_at + make_interval(days => (v_pol->'depth'->>'start_days')::integer)) AS email_deep,
        count(*) FILTER (WHERE s.first_talk IS NOT NULL) AS talk_jobs,
        count(*) FILTER (WHERE s.first_talk <= s.created_at + make_interval(days => (v_pol->'depth'->>'start_days')::integer)) AS talk_deep
 INTO v_x
 FROM (SELECT j.id, j.created_at,
              min(coalesce(b.event_at, b.occurred_at)) FILTER (WHERE b.channel = 'email') AS first_email,
              min(coalesce(b.event_at, b.occurred_at)) FILTER (WHERE b.channel IN ('sms', 'call')) AS first_talk
       FROM public.jobs j LEFT JOIN public.business_events b ON b.job_id = j.id AND coalesce(b.context_captured_at, b.recorded_at) <= v_as_of
       WHERE j.id = ANY (v_live) GROUP BY j.id, j.created_at) s;
 v_lanes := v_lanes || jsonb_build_array(
  jsonb_build_object('row', 14, 'lane', 'email_depth',
   'number', CASE WHEN v_x.email_jobs = 0 THEN NULL ELSE round(100.0 * v_x.email_deep / v_x.email_jobs, 1) END,
   'unit', '% of live jobs with email whose earliest email is within ' || (v_pol->'depth'->>'start_days') || ' days of the job''s start',
   'green', (v_pol->'depth'->>'green_pct')::numeric, 'amber', (v_pol->'depth'->>'amber_pct')::numeric, 'higher_is_better', true,
   'status', CASE WHEN v_x.email_jobs = 0 THEN 'green' END,
   'value', v_x.email_deep || ' of ' || v_x.email_jobs || ' live jobs with email', 'note', 'earliest email by event time'),
  jsonb_build_object('row', 14, 'lane', 'texts_calls_depth',
   'number', CASE WHEN v_x.talk_jobs = 0 THEN NULL ELSE round(100.0 * v_x.talk_deep / v_x.talk_jobs, 1) END,
   'unit', '% of live jobs with texts or calls whose earliest one is within ' || (v_pol->'depth'->>'start_days') || ' days of the job''s start',
   'green', (v_pol->'depth'->>'green_pct')::numeric, 'amber', (v_pol->'depth'->>'amber_pct')::numeric, 'higher_is_better', true,
   'status', CASE WHEN v_x.talk_jobs = 0 THEN 'green' END,
   'value', v_x.talk_deep || ' of ' || v_x.talk_jobs || ' live jobs with texts or calls', 'note', 'earliest text or call by event time'));
 SELECT min(p.window_from) INTO v_newest FROM public.context_email_history_plan p;
 SELECT count(*) FILTER (WHERE v_newest IS NOT NULL AND j.created_at >= v_newest) INTO v_n FROM public.jobs j WHERE j.id = ANY (v_live);
 v_lanes := v_lanes || jsonb_build_array(jsonb_build_object('row', 14, 'lane', 'email_history_window',
  'number', CASE WHEN v_live_n = 0 OR v_newest IS NULL THEN NULL ELSE round(100.0 * v_n / v_live_n, 1) END,
  'unit', '% of live jobs that started inside the email history window', 'green', (v_pol->'depth'->>'green_pct')::numeric,
  'amber', (v_pol->'depth'->>'amber_pct')::numeric, 'higher_is_better', true,
  'status', CASE WHEN v_live_n = 0 THEN 'green' END,
  'value', CASE WHEN v_newest IS NULL THEN 'no email history window planned'
                ELSE 'window from ' || to_char((v_newest AT TIME ZONE 'Australia/Perth')::date, 'FMDD Mon YYYY') || '; '
                     || v_n || ' of ' || v_live_n || ' live jobs started inside it' END,
  'note', 'context_email_history_plan, earliest window_from'));

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
  (4, 'History', 'every live job has its CRM, email and Xero history loaded; loads run daily until complete'),
  (5, 'Documents', 'text inside uploaded documents is extracted and readable as evidence'),
  (6, 'Reading', 'every placed item read within 2 hours; unread backlog on live jobs is 0 each morning'),
  (7, 'Facts', 'a published catalogue of fact kinds; an independent grader passes at least 95% on a 10-job sample'),
  (8, 'Job answer', 'the job read is correct on a 10-job graded sample; brief on at 6 of 6, then backfilled'),
  (9, 'Agent use', 'the agent answers correctly for the 10-job test set (and 9+: the story test)'),
  (10, 'Health', 'one scorecard shows rows 1 to 9 per lane and per job; run hourly, red rows reported'),
  (11, 'Job story', 'every live job has a start-to-finish timeline with a cited summary per phase'),
  (12, 'Open loops', 'every live job lists what is promised, asked, owed and unconfirmed, each with why and its source'),
  (13, 'Client view', 'every client with a live job has one view across all their jobs'),
  (14, 'History depth', 'every lane for live jobs is loaded back to each job''s start')
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
  'version', 'context-scorecard-v1', 'as_of', v_as_of, 'live_jobs', v_live_n,
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
  'per_job', jsonb_build_object('function', 'context_scorecard_jobs', 'page_size', 150, 'pages', ceil(v_live_n / 150.0)),
  'policy', v_pol);
END
$fn$;
COMMENT ON FUNCTION public.context_scorecard(timestamptz) IS
 'Context scorecard (20261006032000): the owner''s definition of done, rows 1 to 14 (context-scorecard-v1). Each row has lanes; each lane has status green, amber or red, the number, its unit and both thresholds (context_scorecard_policy); a row is its worst lane. Alarms: lane_quiet (a capture lane quiet past its threshold in Perth working hours) and history_load_stalled (no progress for 3 runs). Rows SQL cannot measure are red with the reason. p_as_of cuts every business_events read (rows captured after it are left out); the job list, status functions, facts, Xero invoices and story rows read the database as it is now. Read only; service role only.';

CREATE OR REPLACE FUNCTION public.context_scorecard_jobs(p_after uuid DEFAULT NULL, p_limit integer DEFAULT 150,
 p_as_of timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE
 v_pol jsonb := public.context_scorecard_policy();
 v_as_of timestamptz := coalesce(p_as_of, now());
 v_limit integer := least(greatest(coalesce(p_limit, 150), 1), 300);
 v_ids uuid[];
 v_story jsonb := '{}'::jsonb;
 v_brief_on boolean;
 v_jobs jsonb;
BEGIN
 v_ids := ARRAY(SELECT jb.id FROM public.jobs jb
                WHERE jb.status::text <> ALL (ARRAY(SELECT jsonb_array_elements_text(v_pol->'live_excluded_statuses')))
                  AND (p_after IS NULL OR jb.id > p_after)
                ORDER BY jb.id LIMIT v_limit);
 IF to_regprocedure('public.context_story_scorecard_jobs(uuid,integer)') IS NOT NULL THEN
  SELECT coalesce(jsonb_object_agg(s->>'job_id', s), '{}'::jsonb) INTO v_story
  FROM jsonb_array_elements(public.context_story_scorecard_jobs(p_after, v_limit)->'jobs') s;
 END IF;
 v_brief_on := EXISTS (SELECT 1 FROM public.feature_flags ff WHERE ff.flag_name = v_pol->'brief'->>'flag' AND ff.enabled);

 WITH pg AS (
  SELECT j.id, j.job_number, j.created_at,
         nullif(btrim(j.ghl_contact_id), '') IS NOT NULL AS has_contact,
         (nullif(btrim(j.ghl_contact_id), '') IS NOT NULL OR nullif(btrim(j.client_email), '') IS NOT NULL) AS identity
  FROM public.jobs j WHERE j.id = ANY (v_ids)
 ),
 ev AS (
  SELECT b.job_id, count(*) AS n_all,
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
 un AS (
  SELECT u.job_id,
         count(*) FILTER (WHERE u.live_mode AND u.cap < v_as_of - make_interval(mins => (v_pol->'reading'->>'live_max_minutes')::integer)) AS live_late,
         count(*) FILTER (WHERE u.live_mode) AS live_n,
         count(*) FILTER (WHERE NOT u.live_mode) AS backlog_n
  FROM (SELECT r.job_id, coalesce(r.context_captured_at, r.recorded_at) AS cap,
               coalesce(r.metadata->>'capture_mode', 'live') NOT IN ('backfill', 'relink') AS live_mode
        FROM public.context_unread_rows(v_ids) r) u
  WHERE u.cap <= v_as_of GROUP BY u.job_id
 ),
 fa AS (
  SELECT f.job_id, count(*) FILTER (WHERE f.kind <> 'job_brief') AS facts, bool_or(f.kind = 'job_brief') AS brief
  FROM public.current_job_context_facts f WHERE f.job_id = ANY (v_ids) GROUP BY f.job_id
 ),
 xi AS (
  SELECT x.job_id, count(*) AS invoices FROM public.xero_invoices x
  WHERE x.job_id = ANY (v_ids) AND coalesce(x.status, '') NOT IN ('VOIDED', 'DELETED') AND coalesce(x.invoice_type, 'ACCREC') = 'ACCREC'
  GROUP BY x.job_id
 ),
 gh AS (
  SELECT DISTINCT unnest(h.job_ids) AS job_id FROM public.context_ghl_history_contacts h WHERE h.status = 'done' AND h.job_ids && v_ids
 ),
 per AS (
  SELECT pg.id, pg.job_number, v_story->(pg.id::text) AS st,
   jsonb_build_array(
    -- Row 2: both sides named on every message on this job.
    jsonb_build_object('row', 2, 'number', CASE WHEN coalesce(ev.msgs, 0) = 0 THEN NULL ELSE round(100.0 * ev.both_known / ev.msgs, 1) END,
     'unit', '% of messages naming both sides',
     'status', CASE WHEN coalesce(ev.msgs, 0) = 0 THEN 'green'
                    WHEN 100.0 * ev.both_known / nullif(ev.msgs, 0) >= (v_pol->'who_to_whom'->>'green_pct')::numeric THEN 'green'
                    WHEN 100.0 * ev.both_known / nullif(ev.msgs, 0) >= (v_pol->'who_to_whom'->>'amber_pct')::numeric THEN 'amber' ELSE 'red' END,
     'value', coalesce(ev.both_known, 0) || ' of ' || coalesce(ev.msgs, 0) || ' messages'),
    -- Row 4: CRM history loaded; Xero evidence when invoiced.
    jsonb_build_object('row', 4, 'number', NULL, 'unit', 'history loaded',
     'status', CASE WHEN (pg.has_contact AND gh.job_id IS NULL) OR (coalesce(xi.invoices, 0) > 0 AND coalesce(ev.xero_rows, 0) = 0) THEN 'red'
                    WHEN NOT pg.has_contact THEN 'amber' ELSE 'green' END,
     'value', CASE WHEN NOT pg.has_contact THEN 'no CRM contact' WHEN gh.job_id IS NULL THEN 'CRM history not loaded' ELSE 'CRM history loaded' END
              || '; ' || CASE WHEN coalesce(xi.invoices, 0) = 0 THEN 'no live Xero invoice'
                              WHEN coalesce(ev.xero_rows, 0) = 0 THEN xi.invoices || ' Xero invoices, no Xero evidence'
                              ELSE xi.invoices || ' Xero invoices with evidence' END),
    -- Row 6: live items read within the limit; backlog waiting.
    jsonb_build_object('row', 6, 'number', coalesce(un.live_late, 0), 'unit', 'live items unread past the limit',
     'status', CASE WHEN coalesce(un.live_late, 0) > 0 THEN 'red' WHEN coalesce(un.live_n, 0) + coalesce(un.backlog_n, 0) > 0 THEN 'amber' ELSE 'green' END,
     'value', coalesce(un.live_n, 0) || ' live and ' || coalesce(un.backlog_n, 0) || ' backlog items unread'),
    -- Row 7: a current fact when there is evidence.
    jsonb_build_object('row', 7, 'number', coalesce(fa.facts, 0), 'unit', 'current facts',
     'status', CASE WHEN coalesce(fa.facts, 0) > 0 THEN 'green' WHEN coalesce(ev.n_all, 0) = 0 THEN 'amber' ELSE 'red' END,
     'value', coalesce(fa.facts, 0) || ' current facts from ' || coalesce(ev.n_all, 0) || ' evidence rows'),
    -- Row 8: a brief (amber while the brief is off everywhere).
    jsonb_build_object('row', 8, 'number', CASE WHEN coalesce(fa.brief, false) THEN 1 ELSE 0 END, 'unit', 'brief present',
     'status', CASE WHEN coalesce(fa.brief, false) THEN 'green' WHEN v_brief_on THEN 'red' ELSE 'amber' END,
     'value', CASE WHEN coalesce(fa.brief, false) THEN 'brief present' ELSE 'no brief' END
              || CASE WHEN v_brief_on THEN '' ELSE ' (brief flag off)' END),
    -- Rows 11 to 13 from context_story_scorecard_jobs.
    jsonb_build_object('row', 11, 'number', (v_story->(pg.id::text)->>'timeline_rows')::integer, 'unit', 'record timeline rows',
     'status', CASE WHEN coalesce((v_story->(pg.id::text)->>'row11_green')::boolean, false) THEN 'green' ELSE 'red' END,
     'value', coalesce(v_story->(pg.id::text)->>'timeline_rows', '?') || ' timeline rows; ledger ' || coalesce(v_story->(pg.id::text)->>'ledger', 'not deployed')
              || ', ' || coalesce(v_story->(pg.id::text)->>'phase_notes', '0') || ' phase notes'),
    jsonb_build_object('row', 12, 'number', (v_story->(pg.id::text)->>'record_loops')::integer, 'unit', 'record loops',
     'status', CASE WHEN coalesce((v_story->(pg.id::text)->>'row12_green')::boolean, false) THEN 'green' ELSE 'red' END,
     'value', coalesce(v_story->(pg.id::text)->>'record_loops', '?') || ' record loops; ledger ' || coalesce(v_story->(pg.id::text)->>'ledger', 'not deployed')
              || CASE WHEN coalesce((v_story->(pg.id::text)->>'ledger_needs_person')::boolean, false) THEN '; needs a person' ELSE '' END),
    jsonb_build_object('row', 13, 'number', CASE WHEN pg.identity THEN 1 ELSE 0 END, 'unit', 'client identity',
     'status', CASE WHEN pg.identity AND v_story ? (pg.id::text) THEN 'green' ELSE 'red' END,
     'value', CASE WHEN pg.identity THEN 'CRM contact or client email' ELSE 'no CRM contact and no client email' END),
    -- Row 14: each lane present reaches back to the job's start.
    jsonb_build_object('row', 14, 'number', NULL, 'unit', 'lanes reaching the job''s start',
     'status', CASE WHEN ev.first_email IS NULL AND ev.first_talk IS NULL THEN 'amber'
                    WHEN ev.first_email > pg.created_at + make_interval(days => (v_pol->'depth'->>'start_days')::integer)
                      OR ev.first_talk > pg.created_at + make_interval(days => (v_pol->'depth'->>'start_days')::integer) THEN 'red'
                    ELSE 'green' END,
     'value', 'job started ' || to_char((pg.created_at AT TIME ZONE 'Australia/Perth')::date, 'FMDD Mon YYYY')
              || '; earliest email ' || coalesce(to_char((ev.first_email AT TIME ZONE 'Australia/Perth')::date, 'FMDD Mon YYYY'), 'none')
              || '; earliest text or call ' || coalesce(to_char((ev.first_talk AT TIME ZONE 'Australia/Perth')::date, 'FMDD Mon YYYY'), 'none'))
   ) AS rows_
  FROM pg LEFT JOIN ev ON ev.job_id = pg.id LEFT JOIN un ON un.job_id = pg.id LEFT JOIN fa ON fa.job_id = pg.id
  LEFT JOIN xi ON xi.job_id = pg.id LEFT JOIN gh ON gh.job_id = pg.id
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('job_id', p.id, 'job_number', p.job_number,
          'status', CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(p.rows_) r WHERE r->>'status' = 'red') THEN 'red'
                         WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(p.rows_) r WHERE r->>'status' = 'amber') THEN 'amber' ELSE 'green' END,
          'red_rows', coalesce((SELECT jsonb_agg((r->>'row')::integer ORDER BY (r->>'row')::integer) FROM jsonb_array_elements(p.rows_) r
                                WHERE r->>'status' = 'red'), '[]'::jsonb),
          'rows', p.rows_) ORDER BY p.id), '[]'::jsonb)
 INTO v_jobs FROM per p;

 RETURN jsonb_build_object('version', 'context-scorecard-jobs-v1', 'as_of', v_as_of,
  'rows_measured', jsonb_build_array(2, 4, 6, 7, 8, 11, 12, 13, 14),
  'jobs', v_jobs,
  'next', CASE WHEN cardinality(v_ids) = v_limit THEN v_ids[v_limit] END);
END
$fn$;
COMMENT ON FUNCTION public.context_scorecard_jobs(uuid, integer, timestamptz) IS
 'Context scorecard (20261006032000): per-job rows of the done definition for one page of live jobs ordered by id after p_after (at most 300, default 150; the order and page of context_story_scorecard_jobs). Rows measured per job: 2 (both sides named), 4 (CRM history, Xero evidence), 6 (unread live and backlog items), 7 (current facts), 8 (brief), 11 to 13 (from context_story_scorecard_jobs), 14 (each lane reaches the job''s start). Each row green, amber or red; a job is its worst row. p_as_of cuts the business_events reads; facts, Xero invoices and rows 11 to 13 read the database as it is now. next = the cursor for the following page, null at the end. Read only; service role only.';

DO $w11$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_scorecard_policy()'::regprocedure) <> '50ed8ccdac924097399359a9857f02a8'
    OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_scorecard(timestamptz)'::regprocedure) <> '82574dfb65328d855ad87683a78ca9cd'
    OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_scorecard_jobs(uuid,integer,timestamptz)'::regprocedure) <> '6fd07f87b10ff8e0164f2daad98cce48' THEN
  RAISE EXCEPTION 'w11_scorecard.sql is not W11''s three bodies';
 END IF;
END $w11$;
