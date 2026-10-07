-- Re-run the last 30 days' bucket rows through the live rules-on ladder (L1g):
-- the read-only measurement, a guarded batch (dry run) and the numbers to check
-- (done definition row 3, 7 Oct 2026). Pair with
-- scripts/context-bucket-rerun-l1g-undo.sql. Production: run each PART on its
-- own, only after migration 20261007070000 is applied (the copy check) and
-- after scripts/context-holding-thread-retire.sql is committed (PART 2 refuses
-- while a live thread binding points at a holding job).
--
-- Not run by its author. PART 1 is READ ONLY. PART 2 is the WRITE, a dry run:
-- as written it ends in ROLLBACK and changes nothing.
--
-- What the bucket is. The rows the scorecard's review_queue lane counts: no
-- job, attribution_status admin_bucket, unplaced, pending_luna or review,
-- captured (context_captured_at, else recorded_at) in the 30 days to the run's
-- instant. The flag context_unlinked_rules_v1 was turned on at 02:32Z on 7 Oct
-- 2026, so a row captured since is decided by the rules-on ladder at capture,
-- but every bucket row captured before then was decided with the rules off and
-- nothing has re-decided it (read 7 Oct 06:20Z: 0 of the older admin_bucket
-- rows re-checked since the flip): rerun_context_attribution re-runs
-- admin_bucket rows only, and only when someone calls it. This script re-decides
-- every bucket row with the rules-on body explicitly,
-- resolve_context_attribution(row, preview false, rules on), whatever the flag
-- says. Rows with no status at all (never attributed: 664 on 7 Oct) are not the
-- bucket and are not re-run, nor is a row already marked a copy
-- (metadata.duplicate_of).
--
-- Three rows are not re-decided like the rest:
--   * A copy of a message already placed and read: another row holds the same
--     GHL message (context_placement_message_twin, twin placed). Re-deciding it
--     would put the message on a job a second time (measured 7 Oct, 11:45Z:
--     130 such key-less copies in the population, 6 of which the rules would
--     place, every one on its twin's job). It is marked in place,
--     metadata.duplicate_of = the twin (the 20261006031000 convention), and
--     otherwise left exactly as it is: no reader reads it again, and nothing
--     the review queue counts changes.
--   * A row Luna already answered (metadata.luna_outcome) that the rules would
--     send back to Luna (pending_luna). Luna's contract rests such a row
--     unplaced, asked once, not again until a named reopen; this re-run is not
--     one. It is left exactly as Luna left it (measured: 129 rows, of the 257
--     the rules would otherwise queue for Luna).
--   * A row the rules place is stamped metadata.capture_mode relink (its mode
--     before kept in capture_mode_before), as the misfile repair stamps its
--     rows. A re-placed old text is history, not news: with capture_mode live
--     the Jarvis event listener (src/automation/event-listener.ts) reads a
--     customer text whose attributed_at lands in its window as a new
--     placement and cancels every pending proposal and nudge on that job
--     (measured 7 Oct, 06:40Z: 81 live customer texts on 22 jobs, which held
--     89 pending proposals and 8 nudges, 38 of the proposals made after the
--     newest re-placed text on their job; at 11:45Z, with the copies marked
--     instead: 75 live customer texts, 10 of whose jobs held 60 pending
--     proposals and 4 nudges), and the reader's cadence would
--     wake a read on every such job. History (backfill or relink) never
--     reacts and never wakes a read: a placed row becomes unread history on its
--     job (row 6 counts it as backlog) until a catch-up reads it. PART 2
--     refuses a batch in which any placed row would read as news.
--
-- What the model is asked. Rows the rules send to review go to Luna
-- (pending_luna) only when captured live (rows loaded as history rest
-- unplaced, never asked: X27). PART 1 reports, before any write: the rows
-- waiting for Luna now, the rows that leave that queue (the history rows
-- waiting there go to review unplaced), the NEW asks (rows that were not
-- waiting and were never answered) and the Luna-answered rows kept out of it.
-- Measured 7 Oct, 11:45Z (window to 04:00Z, the 50 holding bindings emulated
-- as retired): 654 waiting, all 654 leave (history rows go to review
-- unplaced, never asked); 128 rows are new asks, none already answered; the
-- 129 Luna-answered rows the rules would have queued again are kept. Before
-- the Luna rule all 257 went to Luna. Attribution asks are capped at the
-- policy's attribution_calls_day (300 of the 1,000 a day, 20261006060000),
-- so the 128 first asks fit one day's attribution allowance. No other model
-- call is made: no read wakes (every placed row is history).
--
-- What PART 1 measured, read only, 7 Oct 2026 11:45 to 12:05Z (window to 04:00Z,
-- L1g live, flag on since 02:32Z, the 50 holding-job bindings emulated as
-- retired): 3,737 rows (2,720 admin_bucket, 654 pending_luna, 363 unplaced, 0
-- review). The rules place 599: 278 by exact site address, 163 single_open,
-- 84 by a job reference, 37 by the sender's email, 26 internal references (our
-- crew texts), 11 by a live thread; 0 on a holding job, 0 off the job their
-- own payload names, 0 errors; 465 of the 599 land on jobs live today, and 572
-- of them were captured live (each stamped relink). 130 copies are marked, 129
-- Luna answers kept. Of the 3,138 left off a job, 1,312 carry a candidate
-- (before: 1,003 of 3,737), so the review queue's candidate share moves from
-- 26.8% to about 41.8%. Of the 8 bucket rows that follow a holding-job thread,
-- 2 are placed once the threads are retired. The 85 target jobs that hold
-- pending follow-ups (401 proposals, 25 nudges) keep every one.
--
-- What PART 2 writes, per row of one batch: the columns rerun_context_attribution
-- writes (job, contact, attribution and match columns, candidates, event_at,
-- payload, metadata), from the rules-on decision; for a placed row the relink
-- stamp; for a copy only the copy marks (duplicate_of, duplicate_marked);
-- metadata.bucket_rerun {run, at, rules, kept (copy_marked, luna_answered or
-- null), after: {job_id, attribution_status}, prior: {every column it writes,
-- the whole metadata object, the two payload keys the ladder may touch
-- (terminal_time_source, attribution_error)}, bound: [thread keys this row's
-- placement bound], retired: [{key, retired_at}] for the bindings it retired}.
-- Ids and codes only. The ladder may bind a thread (a direct or content_ref
-- placement) or retire one (a content reference disagreeing with a live
-- binding, an order number named for two jobs); both are recorded on the row
-- for the undo. Nothing else moves: words, times, source, channel, direction,
-- thread key and every other payload key are checked unchanged, no row may
-- land on a holding job or off the job its own payload names, no placed row
-- may be a second live copy of a message, and no proposal, nudge or other
-- table is written. Batches of at most 250 rows, so the row locks last
-- seconds, not minutes (a job created meanwhile waits for P1b's
-- reconsideration of the same rows at most that long).
--
-- How to run (production: read only first, a write only with the owner's go).
--   PART 1  read-only measurement, about 5 minutes for 3,700 rows; split it
--           with chunks/chunk in params if one statement is too long (run
--           chunk 1..chunks and add the numbers up; pending_on_target_jobs is
--           keyed by job, so merge it by key). Set window_to to the run's
--           instant and keep it for every batch.
--   PART 2  one guarded batch, oldest checked first (rerun_context_attribution's
--           order). As written it ends in ROLLBACK: a dry run that re-decides,
--           checks and throws it away. It refuses unless the rules-on ladder is
--           L1g or later, migration 20261007070000 is live, the attribution lane
--           is on, no live binding points at a holding job, the batch is
--           exactly expected_rows (PART 2's first statement prints this_batch),
--           no row lands on a holding job or on a job other than the one its
--           own payload names, every placed row is history to the listener and
--           the reader, no placed row duplicates a placed message, every copy
--           is marked and every Luna-answered row is kept, and nothing but the
--           re-run columns moved. To apply (owner's go only): change the final
--           ROLLBACK to COMMIT, run PART 2, and repeat it (each run takes the
--           next batch) until remaining is 0.
--   UNDO    scripts/context-bucket-rerun-l1g-undo.sql puts every row this run
--           id touched back as it was, and removes or un-retires the bindings
--           those rows' decisions made.

-- ============================================================================
-- PART 1. READ ONLY. The measurement.
-- ============================================================================
BEGIN READ ONLY;
SET LOCAL statement_timeout = '900s';

SELECT left(coalesce(obj_description(to_regprocedure('public.resolve_context_attribution(public.business_events,boolean,boolean)'), 'pg_proc'), ''), 4)
  AS rules_ladder,
 to_regprocedure('public.context_placement_message_twin(public.business_events)') IS NOT NULL AS copy_check_installed,
 public.automation_lane_enabled('attribution') AS attribution_lane_on,
 (SELECT enabled FROM public.feature_flags WHERE flag_name = 'context_unlinked_rules_v1') AS rules_flag_now,
 (SELECT count(*) FROM public.event_threads t JOIN public.jobs j ON j.id = t.job_id
  WHERE t.retired_at IS NULL AND coalesce(j.metadata->>'do_not_schedule', '') IN ('true', '1')) AS live_bindings_to_holding_jobs;

WITH params AS (SELECT '2026-10-07 04:00:00+00'::timestamptz AS window_to, 1 AS chunks, 1 AS chunk),
pop AS MATERIALIZED (
 SELECT b.id, ntile((SELECT chunks FROM params)) OVER (ORDER BY b.id) AS part
 FROM public.business_events b, params
 WHERE b.job_id IS NULL AND b.attribution_status IN ('admin_bucket', 'unplaced', 'pending_luna', 'review')
   AND coalesce(b.context_captured_at, b.recorded_at) > params.window_to - interval '30 days'
   AND coalesce(b.context_captured_at, b.recorded_at) <= params.window_to
   AND NOT (coalesce(b.metadata, '{}'::jsonb) ? 'duplicate_of')
),
hold AS MATERIALIZED (
 SELECT t.thread_key FROM public.event_threads t JOIN public.jobs j ON j.id = t.job_id
 WHERE t.retired_at IS NULL AND coalesce(j.metadata->>'do_not_schedule', '') IN ('true', '1')
),
d0 AS MATERIALIZED (
 SELECT b AS ev, coalesce(w.twin_state = 'placed', false) AS copy_of_placed, w.twin_job_id
 FROM public.business_events b JOIN pop ON pop.id = b.id
 LEFT JOIN LATERAL public.context_placement_message_twin(b) w ON true
 WHERE pop.part = (SELECT chunk FROM params)
),
d AS MATERIALIZED (
 -- A row following a live holding-job thread is read as it will be once the retire is committed: that key no
 -- longer bound. A copy of a placed message is not decided (PART 2 marks it).
 SELECT (d0.ev).id, (d0.ev).event_type, (d0.ev).attribution_status AS st0, coalesce(cardinality((d0.ev).candidate_job_ids), 0) > 0 AS cand0,
  coalesce((d0.ev).event_at, (d0.ev).occurred_at) AS msg_at, (d0.ev).thread_key IN (SELECT h.thread_key FROM hold h) AS on_hold_thread,
  coalesce((d0.ev).metadata->>'capture_mode', 'live') AS mode0, coalesce((d0.ev).metadata, '{}'::jsonb) ? 'luna_outcome' AS luna_answered,
  d0.copy_of_placed, d0.twin_job_id,
  CASE WHEN d0.copy_of_placed THEN NULL::public.business_events
   ELSE public.resolve_context_attribution(CASE WHEN (d0.ev).thread_key IN (SELECT h.thread_key FROM hold h)
     THEN jsonb_populate_record(d0.ev, jsonb_build_object('thread_key', 'retired:holding_job:' || (d0.ev).thread_key))
     ELSE d0.ev END, true, true) END AS r
 FROM d0
),
o AS (
 -- What PART 2 writes for each row.
 SELECT d.*,
  CASE WHEN d.copy_of_placed THEN 'copy_marked' WHEN (d.r).attribution_status = 'pending_luna' AND d.luna_answered THEN 'kept_luna_answered'
       WHEN (d.r).job_id IS NOT NULL THEN 'placed' ELSE 'off_job' END AS outcome,
  CASE WHEN d.copy_of_placed OR ((d.r).attribution_status = 'pending_luna' AND d.luna_answered) THEN d.st0 ELSE (d.r).attribution_status END AS st1,
  CASE WHEN d.copy_of_placed OR ((d.r).attribution_status = 'pending_luna' AND d.luna_answered) THEN d.cand0
       ELSE coalesce(cardinality((d.r).candidate_job_ids), 0) > 0 END AS cand1
 FROM d
),
tj AS (
 -- The jobs the batch would place rows on, and what waits on them (what the listener would cancel without the stamp).
 SELECT (o.r).job_id AS job_id, count(*) AS placed,
  count(*) FILTER (WHERE o.event_type = 'client.reply' AND o.mode0 NOT IN ('backfill', 'relink')) AS live_texts
 FROM o WHERE o.outcome = 'placed' GROUP BY 1
),
pend AS (
 SELECT tj.job_id, tj.placed, tj.live_texts,
  (SELECT count(*) FROM public.ai_proposed_actions a WHERE a.job_id = tj.job_id AND a.status IN ('pending', 'proposed', 'draft')) AS proposals,
  (SELECT count(*) FROM public.smart_nudges s WHERE s.job_id = tj.job_id AND s.status IN ('pending', 'scheduled', 'draft')) AS nudges
 FROM tj
)
SELECT jsonb_build_object(
 'rows', count(*),
 'by_status_before', (SELECT jsonb_object_agg(x.k, x.n) FROM (SELECT o2.st0 AS k, count(*) AS n FROM o o2 GROUP BY 1) x),
 'outcome', (SELECT jsonb_object_agg(x.k, x.n) FROM (SELECT o2.outcome AS k, count(*) AS n FROM o o2 GROUP BY 1) x),
 'copies_marked_twin_job_live_today', count(*) FILTER (WHERE o.outcome = 'copy_marked' AND EXISTS (SELECT 1 FROM public.jobs j
   WHERE j.id = o.twin_job_id AND j.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost'))),
 'placed', count(*) FILTER (WHERE o.outcome = 'placed'),
 'placed_by_rule', (SELECT jsonb_object_agg(x.k, x.n) FROM (SELECT coalesce((o2.r).metadata->>'placement_rule', '?') AS k, count(*) AS n
   FROM o o2 WHERE o2.outcome = 'placed' GROUP BY 1) x),
 'placed_by_status_before', (SELECT jsonb_object_agg(x.k, x.n) FROM (SELECT o2.st0 AS k, count(*) AS n
   FROM o o2 WHERE o2.outcome = 'placed' GROUP BY 1) x),
 'placed_by_capture_mode_before', (SELECT jsonb_object_agg(x.k, x.n) FROM (SELECT o2.mode0 AS k, count(*) AS n
   FROM o o2 WHERE o2.outcome = 'placed' GROUP BY 1) x),
 'placed_jobs', count(DISTINCT (o.r).job_id) FILTER (WHERE o.outcome = 'placed'),
 'placed_on_holding_job', count(*) FILTER (WHERE o.outcome = 'placed' AND EXISTS (SELECT 1 FROM public.jobs j
   WHERE j.id = (o.r).job_id AND coalesce(j.metadata->>'do_not_schedule', '') IN ('true', '1'))),
 'placed_on_live_job_today', count(*) FILTER (WHERE o.outcome = 'placed' AND EXISTS (SELECT 1 FROM public.jobs j
   WHERE j.id = (o.r).job_id AND j.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost'))),
 'placed_on_job_created_after_message', count(*) FILTER (WHERE o.outcome = 'placed' AND EXISTS (SELECT 1 FROM public.jobs j
   WHERE j.id = (o.r).job_id AND j.created_at > o.msg_at)),
 -- A placement on a job other than the one the row's own payload names is a new known misfile (PART 2 refuses it).
 'placed_off_payload_job', count(*) FILTER (WHERE o.outcome = 'placed' AND (o.r).payload->>'job_id' IS NOT NULL
   AND (o.r).payload->>'job_id' <> (o.r).job_id::text),
 -- Without the relink stamp the listener would read these as new placements (PART 2 stamps every placed row).
 'listener_without_stamp', jsonb_build_object(
   'placed_live_customer_texts', count(*) FILTER (WHERE o.outcome = 'placed' AND o.event_type = 'client.reply' AND o.mode0 NOT IN ('backfill', 'relink')),
   'jobs', (SELECT count(*) FROM pend WHERE pend.live_texts > 0),
   'pending_proposals', (SELECT coalesce(sum(pend.proposals), 0) FROM pend WHERE pend.live_texts > 0),
   'pending_nudges', (SELECT coalesce(sum(pend.nudges), 0) FROM pend WHERE pend.live_texts > 0)),
 'pending_on_target_jobs', (SELECT coalesce(jsonb_object_agg(pend.job_id, jsonb_build_object('placed', pend.placed,
   'live_texts', pend.live_texts, 'proposals', pend.proposals, 'nudges', pend.nudges)), '{}'::jsonb)
   FROM pend WHERE pend.proposals + pend.nudges > 0),
 'holding_thread_rows', count(*) FILTER (WHERE o.on_hold_thread),
 'holding_thread_rows_placed', count(*) FILTER (WHERE o.on_hold_thread AND o.outcome = 'placed'),
 'off_job_after', count(*) FILTER (WHERE o.outcome <> 'placed'),
 'off_job_after_with_candidate', count(*) FILTER (WHERE o.outcome <> 'placed' AND o.cand1),
 'with_candidate_before', count(*) FILTER (WHERE o.cand0),
 'status_after', (SELECT jsonb_object_agg(x.k, x.n) FROM (SELECT coalesce(o2.st1, '-') AS k, count(*) AS n FROM o o2 GROUP BY 1) x),
 'model_queue', jsonb_build_object(
   'waiting_before', count(*) FILTER (WHERE o.st0 = 'pending_luna'),
   'waiting_after', count(*) FILTER (WHERE o.st1 = 'pending_luna'),
   'stay', count(*) FILTER (WHERE o.st0 = 'pending_luna' AND o.st1 = 'pending_luna'),
   'leave', count(*) FILTER (WHERE o.st0 = 'pending_luna' AND o.st1 IS DISTINCT FROM 'pending_luna'),
   'new_asks', count(*) FILTER (WHERE o.st0 IS DISTINCT FROM 'pending_luna' AND o.st1 = 'pending_luna'),
   'new_asks_already_answered', count(*) FILTER (WHERE o.st0 IS DISTINCT FROM 'pending_luna' AND o.st1 = 'pending_luna' AND o.luna_answered),
   'kept_luna_answered', count(*) FILTER (WHERE o.outcome = 'kept_luna_answered')),
 'errors', count(*) FILTER (WHERE (o.r).payload ? 'attribution_error')
) AS rerun_preview
FROM o;
ROLLBACK;

-- ============================================================================
-- PART 2. WRITE (dry run). One batch.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

DO $pre$
BEGIN
 IF coalesce(obj_description(to_regprocedure('public.resolve_context_attribution(public.business_events,boolean,boolean)'), 'pg_proc'), '') !~ '^L1[g-z]:' THEN
  RAISE EXCEPTION 'bucket_rerun_l1g: the rules-on ladder is not L1g or later; refusing';
 END IF;
 IF to_regprocedure('public.context_placement_message_twin(public.business_events)') IS NULL THEN
  RAISE EXCEPTION 'bucket_rerun_l1g: migration 20261007070000 is not live (the copy check is missing); refusing';
 END IF;
 IF NOT public.automation_lane_enabled('attribution') THEN
  RAISE EXCEPTION 'bucket_rerun_l1g: the attribution lane is off, so the ladder would place nothing; refusing';
 END IF;
 IF EXISTS (SELECT 1 FROM public.event_threads t JOIN public.jobs j ON j.id = t.job_id
            WHERE t.retired_at IS NULL AND coalesce(j.metadata->>'do_not_schedule', '') IN ('true', '1')) THEN
  RAISE EXCEPTION 'bucket_rerun_l1g: a live thread binding points at a holding job; commit scripts/context-holding-thread-retire.sql first';
 END IF;
END $pre$;

-- The run's window (the same for every batch) and how much of it is left.
CREATE TEMP TABLE rr_params ON COMMIT DROP AS
SELECT '2026-10-07 04:00:00+00'::timestamptz AS window_to, 250 AS batch_size, 'context_bucket_rerun_l1g_20261007'::text AS run_id;
SELECT count(*) AS remaining, least(count(*), (SELECT batch_size FROM rr_params)) AS this_batch
FROM public.business_events b, rr_params p
WHERE b.job_id IS NULL AND b.attribution_status IN ('admin_bucket', 'unplaced', 'pending_luna', 'review')
  AND coalesce(b.context_captured_at, b.recorded_at) > p.window_to - interval '30 days'
  AND coalesce(b.context_captured_at, b.recorded_at) <= p.window_to
  AND NOT (coalesce(b.metadata, '{}'::jsonb) ? 'duplicate_of')
  AND b.metadata->'bucket_rerun'->>'run' IS DISTINCT FROM p.run_id;

CREATE TEMP TABLE rr_batch ON COMMIT DROP AS
SELECT b.id FROM public.business_events b, rr_params p
WHERE b.job_id IS NULL AND b.attribution_status IN ('admin_bucket', 'unplaced', 'pending_luna', 'review')
  AND coalesce(b.context_captured_at, b.recorded_at) > p.window_to - interval '30 days'
  AND coalesce(b.context_captured_at, b.recorded_at) <= p.window_to
  AND NOT (coalesce(b.metadata, '{}'::jsonb) ? 'duplicate_of')
  AND b.metadata->'bucket_rerun'->>'run' IS DISTINCT FROM p.run_id
ORDER BY b.attribution_checked_at NULLS FIRST, b.occurred_at, b.id
LIMIT (SELECT batch_size FROM rr_params)
FOR UPDATE OF b SKIP LOCKED;

CREATE TEMP TABLE rr_before ON COMMIT DROP AS
SELECT e.* FROM public.business_events e JOIN rr_batch x ON x.id = e.id;

CREATE TEMP TABLE rr_scorecard_before ON COMMIT DROP AS
SELECT l FROM jsonb_array_elements((public.context_scorecard(now()))->'rows') r, jsonb_array_elements(r->'lanes') l WHERE (r->>'row')::int = 3;

DO $count$
DECLARE
 -- The this_batch figure printed above (250 while 250 or more remain). The write refuses on any other count.
 expected_rows constant integer := 250;
 n integer;
BEGIN
 SELECT count(*) INTO n FROM rr_batch;
 IF n <> expected_rows THEN
  RAISE EXCEPTION 'bucket_rerun_l1g: the batch is % rows, expected % (a row may be locked by a writer); re-read this_batch', n, expected_rows;
 END IF;
END $count$;

DO $run$
DECLARE
 e public.business_events; r public.business_events; v_start timestamptz; v_bound jsonb; v_retired jsonb; v_sk text;
 v_twin uuid; v_twin_job uuid; v_twin_state text; v_kept text;
 p record;
BEGIN
 SELECT * INTO p FROM rr_params;
 FOR e IN SELECT b.* FROM public.business_events b JOIN rr_batch x ON x.id = b.id
          ORDER BY b.attribution_checked_at NULLS FIRST, b.occurred_at, b.id LOOP
  v_start := clock_timestamp();
  v_kept := NULL; v_twin := NULL; v_twin_job := NULL; v_twin_state := NULL;
  -- A copy of a message already placed and read is marked, never decided (a second live copy otherwise).
  SELECT w.twin_id, w.twin_job_id, w.twin_state INTO v_twin, v_twin_job, v_twin_state
  FROM public.context_placement_message_twin(e) w;
  IF v_twin_state = 'placed' THEN
   v_kept := 'copy_marked';
   r := e;
   r.metadata := coalesce(e.metadata, '{}'::jsonb) || jsonb_build_object('duplicate_of', v_twin::text,
    'duplicate_marked', jsonb_build_object('by', p.run_id, 'rule', 'same_ghl_message', 'census', 'context_placement_message_twin_v1',
     'twin_job_id', v_twin_job, 'at', now()));
  ELSE
   r := public.resolve_context_attribution(e, false, true);
   IF r.attribution_status = 'pending_luna' AND coalesce(e.metadata, '{}'::jsonb) ? 'luna_outcome' THEN
    -- Luna already answered it: asked once, not again until a named reopen. It stays exactly as Luna left it.
    v_kept := 'luna_answered';
    r := e;
   ELSIF r.job_id IS NOT NULL THEN
    -- A re-placed old row is history to the Jarvis listener and to the reader, never news.
    r.metadata := coalesce(r.metadata, '{}'::jsonb) || jsonb_build_object('capture_mode', 'relink',
     'capture_mode_before', coalesce(e.metadata->'capture_mode_before', to_jsonb(coalesce(e.metadata->>'capture_mode', 'live'))));
   END IF;
  END IF;
  -- The bindings this decision made or retired (the ladder binds with bound_at = now() and retires with clock_timestamp()).
  v_sk := public.context_sender_key(e);
  SELECT coalesce(jsonb_agg(t.thread_key ORDER BY t.thread_key COLLATE "C"), '[]'::jsonb) INTO v_bound
  FROM public.event_threads t WHERE t.source_event_id = e.id AND t.bound_at = now() AND t.bound_by = 'ladder';
  SELECT coalesce(jsonb_agg(jsonb_build_object('key', t.thread_key, 'retired_at', t.retired_at) ORDER BY t.thread_key COLLATE "C"), '[]'::jsonb)
  INTO v_retired
  FROM public.event_threads t
  WHERE t.retired_at >= v_start AND t.retired_at <= clock_timestamp()
    AND (t.thread_key = e.thread_key OR (v_sk IS NOT NULL AND t.thread_key LIKE 'supplier_ref:' || v_sk || ':%'));
  UPDATE public.business_events SET
   job_id = r.job_id, contact_id = r.contact_id, attribution_status = r.attribution_status, attribution_step = r.attribution_step,
   attribution_confidence = r.attribution_confidence, attributed_at = r.attributed_at, attribution_checked_at = r.attribution_checked_at,
   event_at = r.event_at, match_status = r.match_status, match_method = r.match_method, match_confidence = r.match_confidence,
   candidate_job_ids = r.candidate_job_ids, payload = r.payload,
   metadata = coalesce(r.metadata, '{}'::jsonb) || jsonb_build_object('bucket_rerun', jsonb_build_object(
    'run', p.run_id, 'at', now(), 'rules', left(obj_description(to_regprocedure('public.resolve_context_attribution(public.business_events,boolean,boolean)'), 'pg_proc'), 3),
    'kept', v_kept,
    'after', jsonb_build_object('job_id', r.job_id, 'attribution_status', r.attribution_status),
    'prior', jsonb_build_object('job_id', e.job_id, 'contact_id', e.contact_id, 'attribution_status', e.attribution_status,
     'attribution_step', e.attribution_step, 'attribution_confidence', e.attribution_confidence, 'attributed_at', e.attributed_at,
     'attribution_checked_at', e.attribution_checked_at, 'event_at', e.event_at, 'match_status', e.match_status,
     'match_method', e.match_method, 'match_confidence', e.match_confidence, 'candidate_job_ids', to_jsonb(e.candidate_job_ids),
     'metadata', coalesce(e.metadata, '{}'::jsonb),
     'payload_keys', jsonb_strip_nulls(jsonb_build_object('terminal_time_source', e.payload->'terminal_time_source',
                                                          'attribution_error', e.payload->'attribution_error'))),
    'bound', v_bound, 'retired', v_retired))
  WHERE id = e.id;
 END LOOP;
END $run$;

DO $check$
DECLARE n integer; want integer := (SELECT count(*) FROM rr_batch);
BEGIN
 SELECT count(*) INTO n FROM public.business_events e JOIN rr_batch x ON x.id = e.id
 WHERE e.metadata->'bucket_rerun'->>'run' = (SELECT run_id FROM rr_params)
   AND e.metadata->'bucket_rerun'->'prior'->'metadata' = coalesce((SELECT b.metadata FROM rr_before b WHERE b.id = e.id), '{}'::jsonb);
 IF n <> want THEN RAISE EXCEPTION 'bucket_rerun_l1g: % of % rows carry the run stamp and their prior; refusing', n, want; END IF;
 -- No row lands on a holding job.
 SELECT count(*) INTO n FROM public.business_events e JOIN rr_batch x ON x.id = e.id
 JOIN public.jobs j ON j.id = e.job_id AND coalesce(j.metadata->>'do_not_schedule', '') IN ('true', '1');
 IF n <> 0 THEN RAISE EXCEPTION 'bucket_rerun_l1g: % rows would land on a holding job; refusing', n; END IF;
 -- No new known misfile: a row placed on a job other than the one its own payload names (the payload_job_mismatch
 -- class) is left for a person, not written.
 SELECT count(*) INTO n FROM public.business_events e JOIN rr_batch x ON x.id = e.id
 WHERE e.job_id IS NOT NULL AND e.payload->>'job_id' IS NOT NULL AND e.payload->>'job_id' <> e.job_id::text;
 IF n <> 0 THEN
  RAISE EXCEPTION 'bucket_rerun_l1g: % rows would sit on a job other than the one their payload names (new known misfiles); refusing', n;
 END IF;
 -- Every placed row is history, never news: the Jarvis listener skips it (no proposal or nudge is cancelled) and
 -- the reader's cadence wakes no read for it. Its mode before is kept.
 SELECT count(*) INTO n FROM public.business_events e JOIN rr_before b ON b.id = e.id
 WHERE e.job_id IS NOT NULL
   AND (e.metadata->>'capture_mode' IS DISTINCT FROM 'relink'
    OR e.metadata->'capture_mode_before' IS DISTINCT FROM coalesce(b.metadata->'capture_mode_before', to_jsonb(coalesce(b.metadata->>'capture_mode', 'live'))));
 IF n <> 0 THEN
  RAISE EXCEPTION 'bucket_rerun_l1g: % placed rows would read as new placements to the Jarvis listener and the reader (no relink stamp); refusing', n;
 END IF;
 -- No placed row is a second live copy of a message already placed and read.
 SELECT count(*) INTO n FROM public.business_events e JOIN rr_batch x ON x.id = e.id
 CROSS JOIN LATERAL public.context_placement_message_twin(e) w
 WHERE public.context_event_source_admissible(e) AND w.twin_state = 'placed';
 IF n <> 0 THEN RAISE EXCEPTION 'bucket_rerun_l1g: % placed rows would be a second live copy of a message already read; refusing', n; END IF;
 -- A copy is marked and otherwise as it was, its twin still read; a Luna-answered row is exactly as Luna left it.
 SELECT count(*) INTO n FROM public.business_events e JOIN rr_before b ON b.id = e.id
 WHERE e.metadata->'bucket_rerun'->>'kept' IN ('copy_marked', 'luna_answered')
   AND (e.job_id IS DISTINCT FROM b.job_id OR e.attribution_status IS DISTINCT FROM b.attribution_status
    OR e.candidate_job_ids IS DISTINCT FROM b.candidate_job_ids OR e.payload IS DISTINCT FROM b.payload
    OR e.attributed_at IS DISTINCT FROM b.attributed_at
    OR (e.metadata - 'bucket_rerun' - 'duplicate_of' - 'duplicate_marked' - 'party_roles') IS DISTINCT FROM (coalesce(b.metadata, '{}'::jsonb) - 'party_roles')
    OR (e.metadata->'bucket_rerun'->>'kept' = 'copy_marked' AND NOT EXISTS (SELECT 1 FROM public.business_events t
         WHERE t.id::text = e.metadata->>'duplicate_of' AND public.context_event_source_admissible(t)))
    OR (e.metadata->'bucket_rerun'->>'kept' = 'luna_answered' AND e.metadata ? 'duplicate_of'));
 IF n <> 0 THEN RAISE EXCEPTION 'bucket_rerun_l1g: % kept rows changed beyond their marks; refusing', n; END IF;
 -- No row Luna already answered goes back to Luna.
 SELECT count(*) INTO n FROM public.business_events e JOIN rr_before b ON b.id = e.id
 WHERE e.attribution_status = 'pending_luna' AND b.attribution_status IS DISTINCT FROM 'pending_luna' AND (coalesce(b.metadata, '{}'::jsonb) ? 'luna_outcome');
 IF n <> 0 THEN RAISE EXCEPTION 'bucket_rerun_l1g: % rows Luna already answered would be asked again; refusing', n; END IF;
 -- Nothing but the re-run columns moved, and no payload key but the two the ladder owns.
 SELECT count(*) INTO n FROM public.business_events e JOIN rr_before b ON b.id = e.id
 WHERE e.event_type IS DISTINCT FROM b.event_type OR e.source IS DISTINCT FROM b.source OR e.channel IS DISTINCT FROM b.channel
  OR e.direction IS DISTINCT FROM b.direction OR e.thread_key IS DISTINCT FROM b.thread_key OR e.occurred_at IS DISTINCT FROM b.occurred_at
  OR e.recorded_at IS DISTINCT FROM b.recorded_at OR e.context_captured_at IS DISTINCT FROM b.context_captured_at
  OR e.body_preview IS DISTINCT FROM b.body_preview OR e.provider_message_id IS DISTINCT FROM b.provider_message_id
  OR (coalesce(e.payload, '{}'::jsonb) - 'terminal_time_source' - 'attribution_error')
     IS DISTINCT FROM (coalesce(b.payload, '{}'::jsonb) - 'terminal_time_source' - 'attribution_error');
 IF n <> 0 THEN RAISE EXCEPTION 'bucket_rerun_l1g: % rows changed beyond the re-run columns; refusing', n; END IF;
END $check$;

-- What this batch did: placed (by rule, where), kept, still off a job (with a candidate or not), bindings, and row 3 before -> after.
SELECT x.status_before, x.status_after, x.lands, x.rule, x.kept, count(*) AS rows,
 count(*) FILTER (WHERE x.off_job_with_candidate) AS off_job_with_candidate, sum(x.bound) AS bindings_made, sum(x.retired) AS bindings_retired
FROM (SELECT coalesce(b.attribution_status, '-') AS status_before, coalesce(e.attribution_status, '-') AS status_after,
       CASE WHEN e.job_id IS NULL THEN 'off_job' WHEN EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = e.job_id
         AND j.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')) THEN 'live_job_today'
         ELSE 'closed_job_today' END AS lands,
       coalesce(e.metadata->>'placement_rule', '-') AS rule, coalesce(e.metadata->'bucket_rerun'->>'kept', '-') AS kept,
       e.job_id IS NULL AND coalesce(cardinality(e.candidate_job_ids), 0) > 0 AS off_job_with_candidate,
       jsonb_array_length(e.metadata->'bucket_rerun'->'bound') AS bound, jsonb_array_length(e.metadata->'bucket_rerun'->'retired') AS retired
      FROM public.business_events e JOIN rr_before b ON b.id = e.id) x
GROUP BY x.status_before, x.status_after, x.lands, x.rule, x.kept
ORDER BY x.status_before COLLATE "C", x.status_after COLLATE "C", x.lands COLLATE "C", x.rule COLLATE "C", x.kept COLLATE "C";
-- What waits on the jobs this batch placed rows on: left as it is (every placed row is history to the listener).
SELECT count(DISTINCT e.job_id) AS placed_on_jobs,
 count(*) FILTER (WHERE e.event_type = 'client.reply' AND coalesce(b.metadata->>'capture_mode', 'live') NOT IN ('backfill', 'relink'))
  AS live_customer_texts_placed,
 (SELECT count(*) FROM public.ai_proposed_actions a WHERE a.status IN ('pending', 'proposed', 'draft')
   AND a.job_id IN (SELECT e2.job_id FROM public.business_events e2 JOIN rr_batch x2 ON x2.id = e2.id WHERE e2.job_id IS NOT NULL))
  AS pending_proposals_left_alone,
 (SELECT count(*) FROM public.smart_nudges s WHERE s.status IN ('pending', 'scheduled', 'draft')
   AND s.job_id IN (SELECT e2.job_id FROM public.business_events e2 JOIN rr_batch x2 ON x2.id = e2.id WHERE e2.job_id IS NOT NULL))
  AS pending_nudges_left_alone,
 count(*) FILTER (WHERE e.job_id IS NOT NULL AND coalesce(e.metadata->>'capture_mode', '') NOT IN ('backfill', 'relink'))
  AS placed_rows_read_as_news
FROM public.business_events e JOIN rr_before b ON b.id = e.id WHERE e.job_id IS NOT NULL;
SELECT bf.l->>'lane' AS row3_lane, bf.l->>'value' AS before_value, af.l->>'value' AS after_value
FROM rr_scorecard_before bf
JOIN (SELECT l FROM jsonb_array_elements((public.context_scorecard(now()))->'rows') r, jsonb_array_elements(r->'lanes') l
      WHERE (r->>'row')::int = 3) af ON af.l->>'lane' = bf.l->>'lane'
ORDER BY (bf.l->>'lane') COLLATE "C";
ROLLBACK;
