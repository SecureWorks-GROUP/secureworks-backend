-- Re-run the last 30 days' bucket rows through the live rules-on ladder (L1g):
-- the read-only measurement, a guarded batch (dry run) and the numbers to check
-- (done definition row 3, 7 Oct 2026). Pair with
-- scripts/context-bucket-rerun-l1g-undo.sql. Production: run each PART on its
-- own, and only after scripts/context-holding-thread-retire.sql is committed
-- (PART 2 refuses while a live thread binding points at a holding job).
--
-- Not run by its author. PART 1 is READ ONLY. PART 2 is the WRITE, a dry run:
-- as written it ends in ROLLBACK and changes nothing.
--
-- What the bucket is. The rows the scorecard's review_queue lane counts: no
-- job, attribution_status admin_bucket, unplaced, pending_luna or review,
-- captured (context_captured_at, else recorded_at) in the 30 days to the run's
-- instant. Today they were decided by the rules-off ladder (the flag
-- context_unlinked_rules_v1 is off), and nothing re-runs them on a schedule:
-- rerun_context_attribution reads the flag and re-runs admin_bucket rows only.
-- This script re-decides each one with the rules-on body
-- resolve_context_attribution(row, preview false, rules on), exactly the call
-- the flag would make, without turning the flag on. Rows with no status at all
-- (never attributed: 664 on 7 Oct) are not the bucket and are not re-run.
--
-- What PART 1 measured, read only, as of 7 Oct 2026 04:00Z (L1g live, flag
-- off, the 50 holding-job bindings emulated as retired): 3,737 rows (2,727
-- admin_bucket, 656 pending_luna, 365 unplaced, 0 review). The rules place 605
-- of them: 285 by exact site address, 163 single_open,
-- 84 by a job reference, 37 by the sender's email, 26 internal references (our
-- crew texts), 10 by a live thread; 0 on a holding job, 0 errors; 471 of the
-- 605 land on jobs live today. Of the 3,132 left off a job, 1,330 carry a
-- candidate (before: 1,003 of 3,737), so the review queue's candidate share
-- moves from 26.8% to 42.5%. 257 rows stay with the model (pending_luna; was
-- 656): a row loaded as history goes to review unplaced, never to the model
-- (X27). Of the 8 bucket rows that follow a holding-job thread, 2 are placed
-- once the threads are retired, 6 rest. Of the 220 bucket rows whose payload
-- names a job (all the old text cache's guesses), the rules place 7, every one
-- on that same job: the re-run makes no new known misfile (PART 2 refuses one).
--
-- What PART 2 writes, per row of one batch: the columns rerun_context_attribution
-- writes (job, contact, attribution and match columns, candidates, event_at,
-- payload, metadata), from the rules-on decision; metadata.bucket_rerun {run,
-- at, rules, after: {job_id, attribution_status}, prior: {every column it
-- writes, the whole metadata object, the two payload keys the ladder may touch
-- (terminal_time_source, attribution_error)}, bound: [thread keys this row's
-- placement bound], retired: [{key, retired_at}] for the bindings it retired}.
-- Ids and codes only. The ladder may bind a thread (a direct or content_ref
-- placement) or retire one (a content reference disagreeing with a live
-- binding, an order number named for two jobs); both are recorded on the row
-- for the undo. Nothing else moves: words, times, source, channel, direction,
-- thread key and every other payload key are checked unchanged, and no row may
-- land on a holding job. Batches of at most 250 rows, so the row locks last
-- seconds, not minutes (a job created meanwhile waits for P1b's reconsideration
-- of the same rows at most that long). No model call is made; a row the rules
-- send to review with candidates waits for Luna only when it was captured live.
--
-- How to run (production: read only first, a write only with the owner's go).
--   PART 1  read-only measurement, about 5 minutes for 3,700 rows; split it
--           with chunks/chunk in params if one statement is too long (run
--           chunk 1..chunks and add the numbers up). Set window_to to the
--           run's instant and keep it for every batch.
--   PART 2  one guarded batch, oldest checked first (rerun_context_attribution's
--           order). As written it ends in ROLLBACK: a dry run that re-decides,
--           checks and throws it away. It refuses unless the rules-on ladder is
--           L1g or later, the attribution lane is on, no live binding points at
--           a holding job, the batch is exactly expected_rows (PART 2's first
--           statement prints this_batch), no row lands on a holding job or on a
--           job other than the one its own payload names, and nothing but the
--           re-run columns moved. To apply (owner's go only):
--           change the final ROLLBACK to COMMIT, run PART 2, and repeat it
--           (each run takes the next batch) until remaining is 0.
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
),
hold AS MATERIALIZED (
 SELECT t.thread_key FROM public.event_threads t JOIN public.jobs j ON j.id = t.job_id
 WHERE t.retired_at IS NULL AND coalesce(j.metadata->>'do_not_schedule', '') IN ('true', '1')
),
d AS MATERIALIZED (
 -- A row following a live holding-job thread is read as it will be once the retire is committed: that key no
 -- longer bound.
 SELECT b.id, b.attribution_status AS st0, coalesce(cardinality(b.candidate_job_ids), 0) > 0 AS cand0,
  coalesce(b.event_at, b.occurred_at) AS msg_at, b.thread_key IN (SELECT h.thread_key FROM hold h) AS on_hold_thread,
  public.resolve_context_attribution(CASE WHEN b.thread_key IN (SELECT h.thread_key FROM hold h)
    THEN jsonb_populate_record(b, jsonb_build_object('thread_key', 'retired:holding_job:' || b.thread_key)) ELSE b END, true, true) AS r
 FROM public.business_events b JOIN pop ON pop.id = b.id
 WHERE pop.part = (SELECT chunk FROM params)
)
SELECT jsonb_build_object(
 'rows', count(*),
 'by_status_before', (SELECT jsonb_object_agg(x.k, x.n) FROM (SELECT d2.st0 AS k, count(*) AS n FROM d d2 GROUP BY 1) x),
 'placed', count(*) FILTER (WHERE (d.r).job_id IS NOT NULL),
 'placed_by_rule', (SELECT jsonb_object_agg(x.k, x.n) FROM (SELECT coalesce((d2.r).metadata->>'placement_rule', '?') AS k, count(*) AS n
   FROM d d2 WHERE (d2.r).job_id IS NOT NULL GROUP BY 1) x),
 'placed_by_status_before', (SELECT jsonb_object_agg(x.k, x.n) FROM (SELECT d2.st0 AS k, count(*) AS n
   FROM d d2 WHERE (d2.r).job_id IS NOT NULL GROUP BY 1) x),
 'placed_jobs', count(DISTINCT (d.r).job_id),
 'placed_on_holding_job', count(*) FILTER (WHERE (d.r).job_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.jobs j
   WHERE j.id = (d.r).job_id AND coalesce(j.metadata->>'do_not_schedule', '') IN ('true', '1'))),
 'placed_on_live_job_today', count(*) FILTER (WHERE (d.r).job_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.jobs j
   WHERE j.id = (d.r).job_id AND j.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost'))),
 'placed_on_job_created_after_message', count(*) FILTER (WHERE (d.r).job_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.jobs j
   WHERE j.id = (d.r).job_id AND j.created_at > d.msg_at)),
 -- A placement on a job other than the one the row's own payload names is a new known misfile (PART 2 refuses it).
 'placed_off_payload_job', count(*) FILTER (WHERE (d.r).job_id IS NOT NULL AND (d.r).payload->>'job_id' IS NOT NULL
   AND (d.r).payload->>'job_id' <> (d.r).job_id::text),
 'holding_thread_rows', count(*) FILTER (WHERE d.on_hold_thread),
 'holding_thread_rows_placed', count(*) FILTER (WHERE d.on_hold_thread AND (d.r).job_id IS NOT NULL),
 'off_job_after', count(*) FILTER (WHERE (d.r).job_id IS NULL),
 'off_job_after_with_candidate', count(*) FILTER (WHERE (d.r).job_id IS NULL AND coalesce(cardinality((d.r).candidate_job_ids), 0) > 0),
 'with_candidate_before', count(*) FILTER (WHERE d.cand0),
 'status_after', (SELECT jsonb_object_agg(x.k, x.n) FROM (SELECT (d2.r).attribution_status AS k, count(*) AS n FROM d d2 GROUP BY 1) x),
 'errors', count(*) FILTER (WHERE (d.r).payload ? 'attribution_error')
) AS rerun_preview
FROM d;
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
  AND b.metadata->'bucket_rerun'->>'run' IS DISTINCT FROM p.run_id;

CREATE TEMP TABLE rr_batch ON COMMIT DROP AS
SELECT b.id FROM public.business_events b, rr_params p
WHERE b.job_id IS NULL AND b.attribution_status IN ('admin_bucket', 'unplaced', 'pending_luna', 'review')
  AND coalesce(b.context_captured_at, b.recorded_at) > p.window_to - interval '30 days'
  AND coalesce(b.context_captured_at, b.recorded_at) <= p.window_to
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
 p record;
BEGIN
 SELECT * INTO p FROM rr_params;
 FOR e IN SELECT b.* FROM public.business_events b JOIN rr_batch x ON x.id = b.id
          ORDER BY b.attribution_checked_at NULLS FIRST, b.occurred_at, b.id LOOP
  v_start := clock_timestamp();
  r := public.resolve_context_attribution(e, false, true);
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

-- What this batch did: placed (by rule, where), still off a job (with a candidate or not), bindings, and row 3 before -> after.
SELECT x.status_before, x.status_after, x.lands, x.rule, count(*) AS rows,
 count(*) FILTER (WHERE x.off_job_with_candidate) AS off_job_with_candidate, sum(x.bound) AS bindings_made, sum(x.retired) AS bindings_retired
FROM (SELECT coalesce(b.attribution_status, '-') AS status_before, coalesce(e.attribution_status, '-') AS status_after,
       CASE WHEN e.job_id IS NULL THEN 'off_job' WHEN EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = e.job_id
         AND j.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')) THEN 'live_job_today'
         ELSE 'closed_job_today' END AS lands,
       coalesce(e.metadata->>'placement_rule', '-') AS rule,
       e.job_id IS NULL AND coalesce(cardinality(e.candidate_job_ids), 0) > 0 AS off_job_with_candidate,
       jsonb_array_length(e.metadata->'bucket_rerun'->'bound') AS bound, jsonb_array_length(e.metadata->'bucket_rerun'->'retired') AS retired
      FROM public.business_events e JOIN rr_before b ON b.id = e.id) x
GROUP BY x.status_before, x.status_after, x.lands, x.rule
ORDER BY x.status_before COLLATE "C", x.status_after COLLATE "C", x.lands COLLATE "C", x.rule COLLATE "C";
SELECT bf.l->>'lane' AS row3_lane, bf.l->>'value' AS before_value, af.l->>'value' AS after_value
FROM rr_scorecard_before bf
JOIN (SELECT l FROM jsonb_array_elements((public.context_scorecard(now()))->'rows') r, jsonb_array_elements(r->'lanes') l
      WHERE (r->>'row')::int = 3) af ON af.l->>'lane' = bf.l->>'lane'
ORDER BY (bf.l->>'lane') COLLATE "C";
ROLLBACK;
