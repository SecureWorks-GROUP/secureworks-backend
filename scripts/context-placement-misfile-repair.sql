-- The known misfiles parked on the placeholder job: census, guarded repair (dry
-- run) and the numbers to check (done definition row 3, 7 Oct 2026). Pair with
-- scripts/context-placement-misfile-repair-undo.sql. Production: run each PART
-- on its own, and only after migration 20261007070000 is applied.
--
-- Not run by its author. PART 1 is READ ONLY. PART 2 is the WRITE, a dry run:
-- as written it ends in ROLLBACK and changes nothing.
--
-- What they are. The scorecard's known_misfiles lane counts the rows of
-- context_payload_job_mismatch_rows(): a row on a job while its own payload
-- names another. On 7 Oct 2026 (read only) there were 70, every one of them on
-- the archived placeholder job SWF-PDF-BUCKET (metadata.do_not_schedule, no
-- contact, purpose pdf_unlock_bucket): 69 from the old text-cache backfill
-- (source ghl_sms_cache_backfill) and 1 from its one-shot coverage backfill,
-- texts sent 8 May to 22 Sep 2026, all placed there in September as step-1
-- custody (status direct, match_method direct_job_id), so the reviewed
-- payload-job repair (20261002170100) classes them not_contact_rule and moves
-- none ("0 the repair can move"). Their payload names the job that backfill
-- GUESSED (L1e: a declared guess, never proof), and their contact_id is null
-- although each payload carries the GHL contact the conversation belongs to.
-- A placeholder is never a customer's job, so all 70 are wrong where they are.
-- Most are copies: the GHL history load saved the same text again, under its
-- ghl:<id> key, because a row on the placeholder can never stand in for it.
--
-- What the evidence proves, per row: context_placement_misfile_plan() re-runs
-- the live rules-on ladder (L1g) in preview on each row as it would read once
-- repaired (its payload's GHL contact, no job, capture_mode relink, the
-- payload's job set aside), and asks context_placement_message_twin() whether
-- another row already holds the same GHL message (same id, event type and
-- words), then plans
--   duplicate  another row already holds the message and stands in for it
--           (measured 7 Oct 2026, 11:40Z: 40 rows; 31 whose twin is placed and
--           read, 27 of them on the very job the payload names, and 9 whose
--           twin waits in the review queue). Never a second live copy: marked
--           metadata.duplicate_of = the twin (the 20261006031000 convention,
--           so no reader, the ledger or the story reads it again) and put where
--           its twin is: the twin's job, as the twin is placed there, or, while
--           the twin waits in the queue, no job and no queue status (the twin
--           is the queue's item; a second one would be reviewed twice).
--   move    no other row holds it and the ladder independently places it, by
--           its own rule, on the very job the payload names: two signals agree
--           (measured: 12 rows, all single_open: the customer had exactly one
--           live job at the message time, no job finished in the 90 days
--           before, and it is the job the backfill named). Written exactly as
--           the ladder labels that placement (single_open, step 3, confidence
--           1, match_method contact_id), with the contact filled in.
--   review  anything else (measured: 18 rows: two to 23 live jobs at the
--           message time, review_several, or one live job that is not the job
--           named and another finished in the 90 days before,
--           review_recent_other_job). Taken OFF the placeholder into the review
--           queue: unplaced, with the ladder's candidates and the payload's job
--           as candidate_job_ids. Never placed on a guess, and never sent to
--           the model (capture_mode relink: X27).
-- A row that will not sit on the job its payload names (every review row, and
-- a duplicate whose twin sits elsewhere or waits) has that payload job SET
-- ASIDE: payload.job_id is removed (its value kept in
-- metadata.placement_repaired.payload_job_set_aside and in prior, so the undo
-- puts it back). The admission rule and the misfile classifier read a payload
-- job only when it is there, so whichever candidate a reviewer later picks is
-- read and is no misfile; with the guess kept, any pick but the guess would be
-- unreadable and a new known misfile.
-- Every repaired row is stamped capture_mode relink (its value before kept in
-- capture_mode_before, so it never wakes a read or a Jarvis reaction on its own)
-- and metadata.placement_repaired {rule, by, run, at, plan, from_job_id,
-- to_job_id, duplicate_of, payload_job_set_aside, after, prior}, where prior
-- holds every column, the whole metadata object, the payload job and the
-- payload's md5 as they were, for the undo. Ids and codes only. Nothing else
-- moves: words, times, source, channel, direction, thread key, event_threads,
-- every other payload key and every other table are checked unchanged, and no
-- repaired row that readers read shares its GHL message with another row that
-- is read. The party roles trigger re-stamps party_roles on the write (the job
-- and contact changed); that is reported, and the undo restores the saved stamp.
--
-- What it changes on the scorecard (7 Oct 2026, 11:40Z): known_misfiles 70 -> 0,
-- and 70 rows leave the placeholder (1,038 -> 968 on it). The review queue gains
-- 18 rows, every one with a candidate. 12 rows move (6 onto jobs live today)
-- and 31 copies follow their twin onto its job (28 live today); the moved rows
-- on live jobs become unread history there until the reader reads them (row 6
-- counts them as backlog, capture_mode relink); a catch-up request for those
-- jobs is a separate, budgeted step, not part of this script. The 40 copies are
-- never read, and 9 of them sit on no job and in no queue while their twin
-- waits there.
--
-- How to run (production: read only first, a write only with the owner's go).
--   PART 1  read-only census. Must show the migration live and the plan:
--           move, review, duplicate and leave 0 on holding jobs (these move
--           between classes when a customer's jobs or a twin change). Copy the
--           four counts into PART 2.
--   PART 2  guarded repair. As written it ends in ROLLBACK: a dry run that
--           repairs, checks and throws it away. It locks every misfile row on a
--           holding job, plans them under the lock, locks every twin and
--           re-checks it still stands in, and refuses unless the plan is
--           exactly the expected counts, every row comes out as planned, no
--           misfile is left on a holding job, no second live copy of a message
--           is made, and nothing but the placement columns, the contact, the
--           named metadata keys and the set-aside payload job moved.
--           To apply (owner's go only): change the final ROLLBACK to COMMIT and
--           run PART 2 once.
--   UNDO    scripts/context-placement-misfile-repair-undo.sql puts every row
--           this run id touched back exactly as it was.

-- ============================================================================
-- PART 1. READ ONLY.
-- ============================================================================
BEGIN READ ONLY;
SET LOCAL statement_timeout = '300s';

-- 0. Preconditions: the plan exists (migration 20261007070000), the rules-on
-- ladder is L1g or later, and the attribution lane is on (with it off the ladder
-- places nothing and every row would plan review).
SELECT to_regprocedure('public.context_placement_misfile_plan()') IS NOT NULL AS plan_installed,
 left(coalesce(obj_description(to_regprocedure('public.resolve_context_attribution(public.business_events,boolean,boolean)'), 'pg_proc'), ''), 4)
  AS rules_ladder,
 public.automation_lane_enabled('attribution') AS attribution_lane_on;

-- 1. The plan, by plan, the ladder's answer and (duplicates) where the twin is.
SELECT p.on_holding_job, p.plan, p.decided->>'attribution_status' AS decided_status, p.decided->>'placement_rule' AS decided_rule,
 p.decided->'twin'->>'state' AS twin_state, (p.to_job_id IS NOT DISTINCT FROM p.payload_job_id) AS to_payload_job,
 p.set_aside_payload_job,
 count(*) AS rows, count(DISTINCT p.contact_id) AS customers, count(DISTINCT coalesce(p.to_job_id, p.payload_job_id)) AS jobs,
 count(*) FILTER (WHERE cardinality(p.candidate_job_ids) > 0) AS with_candidates,
 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = p.to_job_id
   AND j.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost'))) AS to_live_job_today
FROM public.context_placement_misfile_plan() p
GROUP BY 1, 2, 3, 4, 5, 6, 7
ORDER BY p.on_holding_job DESC, p.plan COLLATE "C", count(*) DESC, (p.decided->>'attribution_status') COLLATE "C",
 (p.decided->>'placement_rule') COLLATE "C", (p.decided->'twin'->>'state') COLLATE "C";

-- 2. The counts to copy into PART 2.
SELECT count(*) FILTER (WHERE p.plan = 'move') AS expected_move,
 count(*) FILTER (WHERE p.plan = 'review') AS expected_review,
 count(*) FILTER (WHERE p.plan = 'duplicate') AS expected_duplicate,
 count(*) FILTER (WHERE p.on_holding_job AND p.plan NOT IN ('move', 'review', 'duplicate')) AS expected_leave_on_holding
FROM public.context_placement_misfile_plan() p;

-- 3. Where each row would go (ids and job numbers only).
SELECT p.event_id, p.plan, fj.job_number AS from_job, tj.job_number AS to_job, p.duplicate_of,
 (SELECT string_agg(cj.job_number, ' ' ORDER BY cj.job_number COLLATE "C") FROM public.jobs cj WHERE cj.id = ANY (p.candidate_job_ids)) AS candidates,
 p.decided->>'placement_rule' AS rule, p.set_aside_payload_job
FROM public.context_placement_misfile_plan() p
LEFT JOIN public.jobs fj ON fj.id = p.from_job_id
LEFT JOIN public.jobs tj ON tj.id = p.to_job_id
WHERE p.on_holding_job
ORDER BY p.plan COLLATE "C", fj.job_number COLLATE "C", tj.job_number COLLATE "C", p.event_id;
ROLLBACK;

-- ============================================================================
-- PART 2. WRITE (dry run).
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

DO $pre$
BEGIN
 IF to_regprocedure('public.context_placement_misfile_plan()') IS NULL
    OR to_regprocedure('public.context_placement_message_twin(public.business_events)') IS NULL THEN
  RAISE EXCEPTION 'placement_misfile_repair: migration 20261007070000 is not live (context_placement_misfile_plan or the copy check missing); refusing';
 END IF;
 IF coalesce(obj_description(to_regprocedure('public.resolve_context_attribution(public.business_events,boolean,boolean)'), 'pg_proc'), '') !~ '^L1[g-z]:' THEN
  RAISE EXCEPTION 'placement_misfile_repair: the rules-on ladder is not L1g or later; refusing';
 END IF;
 IF NOT public.automation_lane_enabled('attribution') THEN
  RAISE EXCEPTION 'placement_misfile_repair: the attribution lane is off, so the ladder would place nothing; refusing';
 END IF;
END $pre$;

-- Lock every misfile row on a holding job first, then plan them under the lock.
CREATE TEMP TABLE mr_locked ON COMMIT DROP AS
SELECT e.id FROM public.business_events e
WHERE e.id IN (SELECT m.id FROM public.context_payload_job_mismatch_rows() m
               JOIN public.jobs j ON j.id = m.from_job_id AND coalesce(j.metadata->>'do_not_schedule', '') IN ('true', '1'))
FOR UPDATE OF e;

CREATE TEMP TABLE mr_plan ON COMMIT DROP AS
SELECT p.* FROM public.context_placement_misfile_plan() p WHERE p.event_id IN (SELECT l.id FROM mr_locked l);

-- Lock every twin (nobody may move it while its copy follows it), then re-check under the lock that each
-- still stands in exactly as planned.
CREATE TEMP TABLE mr_twin ON COMMIT DROP AS
SELECT t.id, t.job_id, t.attribution_status, t.attribution_step, t.attribution_confidence, t.match_status, t.match_method,
 t.match_confidence
FROM public.business_events t WHERE t.id IN (SELECT p.duplicate_of FROM mr_plan p WHERE p.plan = 'duplicate')
FOR SHARE OF t;

CREATE TEMP TABLE mr_before ON COMMIT DROP AS
SELECT e.id, e.job_id, e.contact_id, e.attribution_status, e.attribution_step, e.attribution_confidence, e.attributed_at,
 e.attribution_checked_at, e.match_status, e.match_method, e.match_confidence, e.candidate_job_ids, e.metadata, e.payload,
 md5(e.payload::text) AS payload_md5, e.event_type, e.source, e.channel, e.direction, e.thread_key, e.occurred_at, e.event_at,
 e.recorded_at, e.context_captured_at, e.body_preview, e.provider_message_id
FROM public.business_events e JOIN mr_locked l ON l.id = e.id;

CREATE TEMP TABLE mr_threads_before ON COMMIT DROP AS
SELECT md5(coalesce(string_agg(to_jsonb(t)::text, '|' ORDER BY t.thread_key COLLATE "C"), '')) AS h FROM public.event_threads t;

DO $count$
DECLARE
 -- The counts PART 1 printed (12, 18, 40 and 0 on 7 Oct 2026, 11:40Z). The write refuses on any other plan.
 expected_move constant integer := 12;
 expected_review constant integer := 18;
 expected_duplicate constant integer := 40;
 expected_leave_on_holding constant integer := 0;
 n_move integer; n_review integer; n_dup integer; n_leave integer; n_locked integer; n_nocand integer; n integer;
BEGIN
 SELECT count(*) INTO n_locked FROM mr_locked;
 SELECT count(*) FILTER (WHERE plan = 'move'), count(*) FILTER (WHERE plan = 'review'), count(*) FILTER (WHERE plan = 'duplicate'),
        count(*) FILTER (WHERE plan NOT IN ('move', 'review', 'duplicate')),
        count(*) FILTER (WHERE plan = 'review' AND coalesce(cardinality(candidate_job_ids), 0) = 0)
 INTO n_move, n_review, n_dup, n_leave, n_nocand FROM mr_plan;
 IF n_move <> expected_move OR n_review <> expected_review OR n_dup <> expected_duplicate OR n_leave <> expected_leave_on_holding
    OR n_locked <> expected_move + expected_review + expected_duplicate + expected_leave_on_holding THEN
  RAISE EXCEPTION 'placement_misfile_repair: the plan is move %, review %, duplicate %, leave % of % locked; expected %, %, %, %; re-run PART 1',
   n_move, n_review, n_dup, n_leave, n_locked, expected_move, expected_review, expected_duplicate, expected_leave_on_holding;
 END IF;
 IF n_nocand <> 0 THEN
  RAISE EXCEPTION 'placement_misfile_repair: % review rows would rest with no candidate job; refusing', n_nocand;
 END IF;
 IF EXISTS (SELECT 1 FROM mr_plan p JOIN mr_before b ON b.id = p.event_id
            WHERE b.job_id IS DISTINCT FROM p.from_job_id OR NOT p.on_holding_job
               OR (p.plan = 'move' AND (p.to_job_id IS NULL OR p.to_job_id IS DISTINCT FROM p.payload_job_id))) THEN
  RAISE EXCEPTION 'placement_misfile_repair: a planned row no longer sits on its holding job, or a move is not to its payload job; refusing';
 END IF;
 -- Every twin stands in exactly as planned, under the lock: placed on the job its copy will follow it to, or
 -- waiting in the queue while its copy takes no job.
 SELECT count(*) INTO n FROM mr_plan p JOIN mr_before b ON b.id = p.event_id
 WHERE p.plan = 'duplicate' AND NOT EXISTS (
  SELECT 1 FROM public.business_events e CROSS JOIN LATERAL public.context_placement_message_twin(e) w
  WHERE e.id = p.event_id AND w.twin_id = p.duplicate_of
    AND ((w.twin_state = 'placed' AND w.twin_job_id = p.to_job_id) OR (w.twin_state = 'queued' AND p.to_job_id IS NULL)));
 IF n <> 0 OR (SELECT count(*) FROM mr_twin) <> (SELECT count(DISTINCT p.duplicate_of) FROM mr_plan p WHERE p.plan = 'duplicate') THEN
  RAISE EXCEPTION 'placement_misfile_repair: % planned copies no longer have the twin they were planned with; re-run PART 1', n;
 END IF;
END $count$;

-- The new state of every planned row, computed once: the columns and the metadata that records them.
CREATE TEMP TABLE mr_new ON COMMIT DROP AS
SELECT x.*,
 (coalesce(b.metadata, '{}'::jsonb)
   - ARRAY['payload_job_guess', 'placement_rule', 'placement_contactless_job_ids', 'placement_guard_job_ids',
           'placement_other_contact_job_ids', 'bucket_reason', 'ref_not_found', 'ref_job_ids', 'identity_conflict',
           'contact_recovered_by', 'writer_unknown', 'custody_rescan', 'placement_site_keys', 'placement_retired_binding',
           'placement_preview_bindings', 'supplier_ref_conflicts', 'aftercare_unpaid_job_ids', 'placement_held_from',
           'source_job_binding'])
  || CASE WHEN x.plan IN ('move', 'review') THEN coalesce(x.ladder_keys, '{}'::jsonb) ELSE '{}'::jsonb END
  || jsonb_build_object('placement_rule', x.rule)
  || CASE WHEN x.payload_job_guess THEN '{"payload_job_guess":true}'::jsonb ELSE '{}'::jsonb END
  || CASE WHEN x.plan = 'duplicate' THEN jsonb_build_object('duplicate_of', x.duplicate_of::text,
       'duplicate_marked', jsonb_build_object('by', 'context_placement_misfile_repair_20261007', 'rule', 'same_ghl_message',
        'census', 'context_placement_message_twin_v1', 'twin_state', x.twin_state, 'at', now())) ELSE '{}'::jsonb END
  || jsonb_build_object(
   'capture_mode', 'relink',
   'capture_mode_before', coalesce(b.metadata->'capture_mode_before', to_jsonb(coalesce(b.metadata->>'capture_mode', 'live'))),
   'placement_repaired', jsonb_build_object('rule', 'holding_job_misfile', 'by', 'scripts/context-placement-misfile-repair.sql',
    'run', 'context_placement_misfile_repair_20261007', 'at', now(), 'plan', x.plan, 'from_job_id', b.job_id,
    'to_job_id', x.new_job_id, 'duplicate_of', x.duplicate_of,
    'payload_job_set_aside', CASE WHEN x.set_aside THEN b.payload->'job_id' END,
    'after', jsonb_build_object('job_id', x.new_job_id, 'attribution_status', x.new_status),
    'prior', jsonb_build_object('job_id', b.job_id, 'contact_id', b.contact_id, 'attribution_status', b.attribution_status,
     'attribution_step', b.attribution_step, 'attribution_confidence', b.attribution_confidence, 'attributed_at', b.attributed_at,
     'attribution_checked_at', b.attribution_checked_at, 'match_status', b.match_status, 'match_method', b.match_method,
     'match_confidence', b.match_confidence, 'candidate_job_ids', to_jsonb(b.candidate_job_ids),
     'metadata', coalesce(b.metadata, '{}'::jsonb), 'payload_job_id', CASE WHEN x.set_aside THEN b.payload->'job_id' END,
     'payload_md5', b.payload_md5))) AS new_metadata,
 CASE WHEN x.set_aside THEN coalesce(b.payload, '{}'::jsonb) - 'job_id' ELSE b.payload END AS new_payload
FROM (
 SELECT p.event_id AS id, p.plan, p.duplicate_of, p.set_aside_payload_job AS set_aside, p.decided->'ladder_keys' AS ladder_keys,
  coalesce((p.decided->>'payload_job_guess')::boolean, false) AS payload_job_guess, p.decided->'twin'->>'state' AS twin_state,
  CASE WHEN p.plan IN ('move', 'duplicate') THEN p.to_job_id END AS new_job_id,
  coalesce(nullif(btrim(b0.contact_id), ''), p.contact_id) AS new_contact,
  CASE p.plan WHEN 'move' THEN p.decided->>'attribution_status' WHEN 'review' THEN 'unplaced'
   ELSE CASE WHEN p.to_job_id IS NOT NULL THEN t.attribution_status END END AS new_status,
  CASE p.plan WHEN 'move' THEN (p.decided->>'attribution_step')::smallint
   WHEN 'review' THEN coalesce((p.decided->>'attribution_step')::smallint, 5::smallint)
   ELSE CASE WHEN p.to_job_id IS NOT NULL THEN t.attribution_step END END AS new_step,
  CASE p.plan WHEN 'move' THEN (p.decided->>'attribution_confidence')::numeric WHEN 'review' THEN NULL::numeric
   ELSE CASE WHEN p.to_job_id IS NOT NULL THEN t.attribution_confidence END END AS new_confidence,
  CASE p.plan WHEN 'move' THEN p.decided->>'match_status' WHEN 'review' THEN 'unresolved'
   ELSE CASE WHEN p.to_job_id IS NOT NULL THEN t.match_status ELSE 'unresolved' END END AS new_match_status,
  CASE p.plan WHEN 'move' THEN p.decided->>'match_method' WHEN 'review' THEN 'none'
   ELSE CASE WHEN p.to_job_id IS NOT NULL THEN t.match_method ELSE 'none' END END AS new_match_method,
  CASE p.plan WHEN 'move' THEN (p.decided->>'match_confidence')::numeric WHEN 'review' THEN NULL::numeric
   ELSE CASE WHEN p.to_job_id IS NOT NULL THEN t.match_confidence END END AS new_match_confidence,
  CASE WHEN p.plan = 'review' THEN p.candidate_job_ids END AS new_candidates,
  CASE p.plan WHEN 'move' THEN coalesce(p.decided->>'placement_rule', 'single_open')
   WHEN 'review' THEN coalesce(p.decided->>'placement_rule', 'holding_job_review') ELSE 'duplicate_of_twin' END AS rule,
  CASE WHEN p.plan = 'move' OR (p.plan = 'duplicate' AND p.to_job_id IS NOT NULL) THEN true ELSE false END AS placed
 FROM mr_plan p JOIN mr_before b0 ON b0.id = p.event_id LEFT JOIN mr_twin t ON t.id = p.duplicate_of
 WHERE p.plan IN ('move', 'review', 'duplicate')
) x JOIN mr_before b ON b.id = x.id;

UPDATE public.business_events e SET
 job_id = n.new_job_id,
 contact_id = n.new_contact,
 attribution_status = n.new_status,
 attribution_step = n.new_step,
 attribution_confidence = n.new_confidence,
 attributed_at = CASE WHEN n.placed THEN now() END,
 attribution_checked_at = now(),
 match_status = n.new_match_status,
 match_method = n.new_match_method,
 match_confidence = n.new_match_confidence,
 candidate_job_ids = n.new_candidates,
 payload = n.new_payload,
 metadata = n.new_metadata
FROM mr_new n
WHERE e.id = n.id;

DO $check$
DECLARE n integer; want integer := (SELECT count(*) FROM mr_plan WHERE plan IN ('move', 'review', 'duplicate'));
BEGIN
 -- Every row came out exactly as planned.
 SELECT count(*) INTO n FROM public.business_events e JOIN mr_plan p ON p.event_id = e.id JOIN mr_new x ON x.id = e.id
 WHERE e.metadata->'placement_repaired'->>'run' = 'context_placement_misfile_repair_20261007'
  AND e.metadata->>'capture_mode' = 'relink'
  AND e.contact_id IS NOT DISTINCT FROM coalesce((SELECT nullif(btrim(b.contact_id), '') FROM mr_before b WHERE b.id = e.id), p.contact_id)
  AND e.metadata->'placement_repaired'->'after' = jsonb_build_object('job_id', e.job_id, 'attribution_status', e.attribution_status)
  AND CASE p.plan
   WHEN 'move' THEN e.job_id = p.to_job_id AND e.attribution_status = p.decided->>'attribution_status'
    AND public.context_linked_status(e.attribution_status) AND e.match_method = p.decided->>'match_method' AND e.candidate_job_ids IS NULL
    AND public.context_event_source_admissible(e)
   WHEN 'review' THEN e.job_id IS NULL AND e.attribution_status = 'unplaced' AND e.match_method = 'none'
    AND e.candidate_job_ids = p.candidate_job_ids AND cardinality(e.candidate_job_ids) > 0
   WHEN 'duplicate' THEN e.metadata->>'duplicate_of' = p.duplicate_of::text AND NOT public.context_event_source_admissible(e)
    AND e.job_id IS NOT DISTINCT FROM p.to_job_id AND e.candidate_job_ids IS NULL
    AND CASE WHEN p.to_job_id IS NULL THEN e.attribution_status IS NULL AND e.match_method = 'none'
             ELSE e.attribution_status IS NOT DISTINCT FROM (SELECT t.attribution_status FROM mr_twin t WHERE t.id = p.duplicate_of) END
   ELSE false END;
 IF n <> want THEN RAISE EXCEPTION 'placement_misfile_repair: % of % rows came out as planned; refusing', n, want; END IF;
 -- No known misfile is left on a holding job.
 SELECT count(*) INTO n FROM public.context_payload_job_mismatch_rows() m
 JOIN public.jobs j ON j.id = m.from_job_id AND coalesce(j.metadata->>'do_not_schedule', '') IN ('true', '1');
 IF n <> 0 THEN RAISE EXCEPTION 'placement_misfile_repair: % misfiles are still on a holding job; refusing', n; END IF;
 -- No second live copy: no repaired row that readers read shares its GHL message with another row they read,
 -- and every copy's twin still stands in (placed and read, or waiting in the queue).
 SELECT count(*) INTO n FROM public.business_events e JOIN mr_plan p ON p.event_id = e.id
 CROSS JOIN LATERAL public.context_placement_message_twin(e) w
 WHERE public.context_event_source_admissible(e) AND w.twin_state = 'placed';
 IF n <> 0 THEN RAISE EXCEPTION 'placement_misfile_repair: % repaired rows would be a second live copy of a message already read; refusing', n; END IF;
 SELECT count(*) INTO n FROM mr_plan p JOIN public.business_events t ON t.id = p.duplicate_of
 WHERE p.plan = 'duplicate' AND NOT (public.context_event_source_admissible(t)
   OR (t.job_id IS NULL AND t.attribution_status IN ('admin_bucket', 'unplaced', 'pending_luna')));
 IF n <> 0 THEN RAISE EXCEPTION 'placement_misfile_repair: % copies would point at a twin that no longer stands in; refusing', n; END IF;
 -- A row that does not sit on its payload job carries no payload job, so a later pick is read and is no misfile.
 SELECT count(*) INTO n FROM public.business_events e JOIN mr_plan p ON p.event_id = e.id
 WHERE (e.payload ? 'job_id') AND e.job_id IS DISTINCT FROM p.payload_job_id;
 IF n <> 0 THEN RAISE EXCEPTION 'placement_misfile_repair: % rows off their payload job still carry it; refusing', n; END IF;
 -- The saved prior is exactly the row as it was.
 SELECT count(*) INTO n FROM public.business_events e JOIN mr_before b ON b.id = e.id
 WHERE e.metadata->'placement_repaired'->'prior'->'metadata' = coalesce(b.metadata, '{}'::jsonb)
  AND (e.metadata->'placement_repaired'->'prior'->>'job_id')::uuid IS NOT DISTINCT FROM b.job_id
  AND e.metadata->'placement_repaired'->'prior'->>'attribution_status' IS NOT DISTINCT FROM b.attribution_status
  AND e.metadata->'placement_repaired'->'prior'->>'match_method' IS NOT DISTINCT FROM b.match_method
  AND e.metadata->'placement_repaired'->'prior'->>'payload_md5' = b.payload_md5
  AND md5((e.payload || coalesce(jsonb_strip_nulls(jsonb_build_object('job_id', e.metadata->'placement_repaired'->'prior'->'payload_job_id')),
       '{}'::jsonb))::text) = b.payload_md5;
 IF n <> want THEN RAISE EXCEPTION 'placement_misfile_repair: % of % rows saved their prior state; refusing', n, want; END IF;
 -- Nothing but the placement columns, the contact, the named metadata keys and a set-aside payload job moved.
 SELECT count(*) INTO n FROM public.business_events e JOIN mr_before b ON b.id = e.id JOIN mr_new x ON x.id = e.id
 WHERE (coalesce(e.payload, '{}'::jsonb) - 'job_id') IS DISTINCT FROM (coalesce(b.payload, '{}'::jsonb) - 'job_id')
  OR (NOT x.set_aside AND e.payload IS DISTINCT FROM b.payload)
  OR e.event_type IS DISTINCT FROM b.event_type
  OR e.source IS DISTINCT FROM b.source OR e.channel IS DISTINCT FROM b.channel OR e.direction IS DISTINCT FROM b.direction
  OR e.thread_key IS DISTINCT FROM b.thread_key OR e.occurred_at IS DISTINCT FROM b.occurred_at OR e.event_at IS DISTINCT FROM b.event_at
  OR e.recorded_at IS DISTINCT FROM b.recorded_at OR e.context_captured_at IS DISTINCT FROM b.context_captured_at
  OR e.body_preview IS DISTINCT FROM b.body_preview OR e.provider_message_id IS DISTINCT FROM b.provider_message_id
  OR (e.metadata - ARRAY['party_roles', 'placement_repaired', 'capture_mode', 'capture_mode_before', 'placement_rule', 'payload_job_guess',
       'placement_guard_job_ids', 'placement_contactless_job_ids', 'placement_other_contact_job_ids', 'aftercare_unpaid_job_ids',
       'contact_recovered_by', 'identity_conflict', 'writer_unknown', 'ref_not_found', 'duplicate_of', 'duplicate_marked'])
     IS DISTINCT FROM (coalesce(b.metadata, '{}'::jsonb) - ARRAY['party_roles', 'capture_mode', 'capture_mode_before', 'placement_rule',
       'payload_job_guess', 'placement_guard_job_ids', 'placement_contactless_job_ids', 'placement_other_contact_job_ids',
       'aftercare_unpaid_job_ids', 'contact_recovered_by', 'identity_conflict', 'writer_unknown', 'ref_not_found', 'bucket_reason',
       'ref_job_ids', 'custody_rescan', 'placement_site_keys', 'placement_retired_binding', 'placement_preview_bindings',
       'supplier_ref_conflicts', 'placement_held_from', 'source_job_binding']);
 IF n <> 0 THEN RAISE EXCEPTION 'placement_misfile_repair: % rows changed beyond the placement; refusing', n; END IF;
 IF (SELECT md5(coalesce(string_agg(to_jsonb(t)::text, '|' ORDER BY t.thread_key COLLATE "C"), '')) FROM public.event_threads t)
    IS DISTINCT FROM (SELECT h FROM mr_threads_before) THEN
  RAISE EXCEPTION 'placement_misfile_repair: a thread binding changed; refusing';
 END IF;
END $check$;

-- What this run did: by plan, the status written, the rule, the job's state today, and the party roles before -> after.
SELECT p.plan, coalesce(e.attribution_status, '-') AS status, e.metadata->>'placement_rule' AS rule,
 count(*) AS rows, count(DISTINCT e.contact_id) AS customers,
 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = e.job_id
   AND j.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost'))) AS on_live_job_today,
 count(*) FILTER (WHERE cardinality(e.candidate_job_ids) > 0) AS with_candidates,
 count(*) FILTER (WHERE public.context_event_source_admissible(e)) AS read_by_readers,
 count(*) FILTER (WHERE NOT (e.payload ? 'job_id') AND (b.payload ? 'job_id')) AS payload_job_set_aside,
 count(*) FILTER (WHERE coalesce(e.context_captured_at, e.recorded_at) > now() - interval '30 days') AS in_scorecard_window,
 string_agg(DISTINCT (b.metadata->'party_roles'->>'audience') || '->' || (e.metadata->'party_roles'->>'audience'), ' ') AS audience_before_after
FROM public.business_events e JOIN mr_plan p ON p.event_id = e.id JOIN mr_before b ON b.id = e.id
GROUP BY p.plan, coalesce(e.attribution_status, '-'), e.metadata->>'placement_rule'
ORDER BY p.plan COLLATE "C", coalesce(e.attribution_status, '-') COLLATE "C", (e.metadata->>'placement_rule') COLLATE "C";
SELECT (SELECT count(*) FROM public.context_payload_job_mismatch_rows()) AS known_misfiles_after;
ROLLBACK;
