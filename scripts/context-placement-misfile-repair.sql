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
--
-- What the evidence proves, per row: context_placement_misfile_plan() re-runs
-- the live rules-on ladder (L1g) in preview on each row as it would read once
-- repaired (its payload's GHL contact, no job, capture_mode relink, the
-- payload's job set aside) and plans
--   move    the ladder independently places it, by its own rule, on the very
--           job the payload names: two signals agree (measured: 40 rows, 24
--           customers, all single_open: the customer had exactly one live job
--           at the message time, no job finished in the 90 days before, and
--           it is the job the backfill named). Written exactly as the ladder
--           labels that placement (single_open, step 3, confidence 1,
--           match_method contact_id), with the contact filled in.
--   review  anything else (measured: 30 rows, 14 customers: 29 with two to 23
--           live jobs at the message time, review_several; 1 whose one live
--           job is not the job named and another finished in the 90 days
--           before, review_recent_other_job). Taken OFF the placeholder into
--           the review queue: unplaced, with the ladder's candidates and the
--           payload's job as candidate_job_ids. Never placed on a guess, and
--           never sent to the model (capture_mode relink: X27).
-- Every moved row is stamped capture_mode relink (its value before kept in
-- capture_mode_before, so it never wakes a read on its own) and
-- metadata.placement_repaired {rule, by, run, at, plan, from_job_id, prior},
-- where prior holds every column and the whole metadata object as they were,
-- for the undo. Ids and codes only. Nothing else moves: payload, words, times,
-- source, channel, direction, thread key, event_threads and every other table
-- are checked unchanged. The party roles trigger re-stamps party_roles on the
-- write (the job and contact changed); that is reported, and the undo restores
-- the saved stamp.
--
-- What it changes on the scorecard: known_misfiles 70 -> 0. The review queue
-- gains 30 rows, every one with a candidate (11 captured in its 30-day window).
-- 34 of the 40 moved rows land on jobs live today: they become unread history
-- on those jobs until the reader reads them (row 6 counts them as backlog,
-- capture_mode relink); a catch-up request for those jobs is a separate,
-- budgeted step, not part of this script.
--
-- How to run (production: read only first, a write only with the owner's go).
--   PART 1  read-only census. Must show the migration live and the plan:
--           move 40, review 30, leave 0 on holding jobs (it only shrinks, or
--           moves between move and review if a customer's jobs change). Copy
--           the three counts into PART 2.
--   PART 2  guarded repair. As written it ends in ROLLBACK: a dry run that
--           repairs, checks and throws it away. It locks every misfile row on a
--           holding job, re-plans them under the lock, and refuses unless the
--           plan is exactly the expected counts, every row comes out as
--           planned, no misfile is left on a holding job, and nothing but the
--           placement columns, the contact and the named metadata keys moved.
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

-- 1. The plan, by plan and the ladder's answer.
SELECT p.on_holding_job, p.plan, p.decided->>'attribution_status' AS decided_status, p.decided->>'placement_rule' AS decided_rule,
 count(*) AS rows, count(DISTINCT p.contact_id) AS customers, count(DISTINCT coalesce(p.to_job_id, p.payload_job_id)) AS jobs,
 count(*) FILTER (WHERE cardinality(p.candidate_job_ids) > 0) AS with_candidates,
 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = p.to_job_id
   AND j.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost'))) AS to_live_job_today
FROM public.context_placement_misfile_plan() p
GROUP BY p.on_holding_job, p.plan, p.decided->>'attribution_status', p.decided->>'placement_rule'
ORDER BY p.on_holding_job DESC, p.plan COLLATE "C", count(*) DESC, (p.decided->>'attribution_status') COLLATE "C",
 (p.decided->>'placement_rule') COLLATE "C";

-- 2. The counts to copy into PART 2.
SELECT count(*) FILTER (WHERE p.plan = 'move') AS expected_move,
 count(*) FILTER (WHERE p.plan = 'review') AS expected_review,
 count(*) FILTER (WHERE p.on_holding_job AND p.plan NOT IN ('move', 'review')) AS expected_leave_on_holding
FROM public.context_placement_misfile_plan() p;

-- 3. Where each row would go (ids and job numbers only).
SELECT p.event_id, p.plan, fj.job_number AS from_job, tj.job_number AS to_job,
 (SELECT string_agg(cj.job_number, ' ' ORDER BY cj.job_number COLLATE "C") FROM public.jobs cj WHERE cj.id = ANY (p.candidate_job_ids)) AS candidates,
 p.decided->>'placement_rule' AS rule
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
 IF to_regprocedure('public.context_placement_misfile_plan()') IS NULL THEN
  RAISE EXCEPTION 'placement_misfile_repair: migration 20261007070000 is not live (context_placement_misfile_plan missing); refusing';
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

CREATE TEMP TABLE mr_before ON COMMIT DROP AS
SELECT e.id, e.job_id, e.contact_id, e.attribution_status, e.attribution_step, e.attribution_confidence, e.attributed_at,
 e.attribution_checked_at, e.match_status, e.match_method, e.match_confidence, e.candidate_job_ids, e.metadata,
 md5(e.payload::text) AS payload_md5, e.event_type, e.source, e.channel, e.direction, e.thread_key, e.occurred_at, e.event_at,
 e.recorded_at, e.context_captured_at, e.body_preview
FROM public.business_events e JOIN mr_locked l ON l.id = e.id;

CREATE TEMP TABLE mr_threads_before ON COMMIT DROP AS
SELECT md5(coalesce(string_agg(to_jsonb(t)::text, '|' ORDER BY t.thread_key COLLATE "C"), '')) AS h FROM public.event_threads t;

DO $count$
DECLARE
 -- The counts PART 1 printed (40, 30 and 0 on 7 Oct 2026). The write refuses on any other plan.
 expected_move constant integer := 40;
 expected_review constant integer := 30;
 expected_leave_on_holding constant integer := 0;
 n_move integer; n_review integer; n_leave integer; n_locked integer; n_nocand integer;
BEGIN
 SELECT count(*) INTO n_locked FROM mr_locked;
 SELECT count(*) FILTER (WHERE plan = 'move'), count(*) FILTER (WHERE plan = 'review'),
        count(*) FILTER (WHERE plan NOT IN ('move', 'review')),
        count(*) FILTER (WHERE plan = 'review' AND coalesce(cardinality(candidate_job_ids), 0) = 0)
 INTO n_move, n_review, n_leave, n_nocand FROM mr_plan;
 IF n_move <> expected_move OR n_review <> expected_review OR n_leave <> expected_leave_on_holding
    OR n_locked <> expected_move + expected_review + expected_leave_on_holding THEN
  RAISE EXCEPTION 'placement_misfile_repair: the plan is move %, review %, leave % of % locked; expected %, %, %; re-run PART 1',
   n_move, n_review, n_leave, n_locked, expected_move, expected_review, expected_leave_on_holding;
 END IF;
 IF n_nocand <> 0 THEN
  RAISE EXCEPTION 'placement_misfile_repair: % review rows would rest with no candidate job; refusing', n_nocand;
 END IF;
 IF EXISTS (SELECT 1 FROM mr_plan p JOIN mr_before b ON b.id = p.event_id
            WHERE b.job_id IS DISTINCT FROM p.from_job_id OR NOT p.on_holding_job
               OR (p.plan = 'move' AND (p.to_job_id IS NULL OR p.to_job_id IS DISTINCT FROM p.payload_job_id))) THEN
  RAISE EXCEPTION 'placement_misfile_repair: a planned row no longer sits on its holding job, or a move is not to its payload job; refusing';
 END IF;
END $count$;

UPDATE public.business_events e SET
 job_id = CASE WHEN p.plan = 'move' THEN p.to_job_id END,
 contact_id = coalesce(nullif(btrim(e.contact_id), ''), p.contact_id),
 attribution_status = CASE WHEN p.plan = 'move' THEN p.decided->>'attribution_status' ELSE 'unplaced' END,
 attribution_step = CASE WHEN p.plan = 'move' THEN (p.decided->>'attribution_step')::smallint
                         ELSE coalesce((p.decided->>'attribution_step')::smallint, 5::smallint) END,
 attribution_confidence = CASE WHEN p.plan = 'move' THEN (p.decided->>'attribution_confidence')::numeric END,
 attributed_at = CASE WHEN p.plan = 'move' THEN now() END,
 attribution_checked_at = now(),
 match_status = CASE WHEN p.plan = 'move' THEN p.decided->>'match_status' ELSE 'unresolved' END,
 match_method = CASE WHEN p.plan = 'move' THEN p.decided->>'match_method' ELSE 'none' END,
 match_confidence = CASE WHEN p.plan = 'move' THEN (p.decided->>'match_confidence')::numeric END,
 candidate_job_ids = CASE WHEN p.plan = 'review' THEN p.candidate_job_ids END,
 metadata = (coalesce(e.metadata, '{}'::jsonb)
   - ARRAY['payload_job_guess', 'placement_rule', 'placement_contactless_job_ids', 'placement_guard_job_ids',
           'placement_other_contact_job_ids', 'bucket_reason', 'ref_not_found', 'ref_job_ids', 'identity_conflict',
           'contact_recovered_by', 'writer_unknown', 'custody_rescan', 'placement_site_keys', 'placement_retired_binding',
           'placement_preview_bindings', 'supplier_ref_conflicts', 'aftercare_unpaid_job_ids', 'placement_held_from',
           'source_job_binding'])
  || coalesce(p.decided->'ladder_keys', '{}'::jsonb)
  || jsonb_build_object('placement_rule', coalesce(p.decided->>'placement_rule', CASE WHEN p.plan = 'move' THEN 'single_open' ELSE 'holding_job_review' END))
  || CASE WHEN (p.decided->>'payload_job_guess')::boolean THEN '{"payload_job_guess":true}'::jsonb ELSE '{}'::jsonb END
  || jsonb_build_object(
   'capture_mode', 'relink',
   'capture_mode_before', coalesce(e.metadata->'capture_mode_before', to_jsonb(coalesce(e.metadata->>'capture_mode', 'live'))),
   'placement_repaired', jsonb_build_object('rule', 'holding_job_misfile', 'by', 'scripts/context-placement-misfile-repair.sql',
    'run', 'context_placement_misfile_repair_20261007', 'at', now(), 'plan', p.plan, 'from_job_id', e.job_id,
    'to_job_id', CASE WHEN p.plan = 'move' THEN p.to_job_id END,
    'prior', jsonb_build_object('job_id', e.job_id, 'contact_id', e.contact_id, 'attribution_status', e.attribution_status,
     'attribution_step', e.attribution_step, 'attribution_confidence', e.attribution_confidence, 'attributed_at', e.attributed_at,
     'attribution_checked_at', e.attribution_checked_at, 'match_status', e.match_status, 'match_method', e.match_method,
     'match_confidence', e.match_confidence, 'candidate_job_ids', to_jsonb(e.candidate_job_ids),
     'metadata', coalesce(e.metadata, '{}'::jsonb))))
FROM mr_plan p
WHERE e.id = p.event_id AND p.plan IN ('move', 'review');

DO $check$
DECLARE n integer; want integer := (SELECT count(*) FROM mr_plan WHERE plan IN ('move', 'review'));
BEGIN
 -- Every row came out exactly as planned.
 SELECT count(*) INTO n FROM public.business_events e JOIN mr_plan p ON p.event_id = e.id
 WHERE e.metadata->'placement_repaired'->>'run' = 'context_placement_misfile_repair_20261007'
  AND e.metadata->>'capture_mode' = 'relink'
  AND e.contact_id IS NOT DISTINCT FROM coalesce((SELECT nullif(btrim(b.contact_id), '') FROM mr_before b WHERE b.id = e.id), p.contact_id)
  AND CASE p.plan
   WHEN 'move' THEN e.job_id = p.to_job_id AND e.attribution_status = p.decided->>'attribution_status'
    AND public.context_linked_status(e.attribution_status) AND e.match_method = p.decided->>'match_method' AND e.candidate_job_ids IS NULL
   WHEN 'review' THEN e.job_id IS NULL AND e.attribution_status = 'unplaced' AND e.match_method = 'none'
    AND e.candidate_job_ids = p.candidate_job_ids AND cardinality(e.candidate_job_ids) > 0
   ELSE false END;
 IF n <> want THEN RAISE EXCEPTION 'placement_misfile_repair: % of % rows came out as planned; refusing', n, want; END IF;
 -- No known misfile is left on a holding job.
 SELECT count(*) INTO n FROM public.context_payload_job_mismatch_rows() m
 JOIN public.jobs j ON j.id = m.from_job_id AND coalesce(j.metadata->>'do_not_schedule', '') IN ('true', '1');
 IF n <> 0 THEN RAISE EXCEPTION 'placement_misfile_repair: % misfiles are still on a holding job; refusing', n; END IF;
 -- The saved prior is exactly the row as it was.
 SELECT count(*) INTO n FROM public.business_events e JOIN mr_before b ON b.id = e.id
 WHERE e.metadata->'placement_repaired'->'prior'->'metadata' = coalesce(b.metadata, '{}'::jsonb)
  AND (e.metadata->'placement_repaired'->'prior'->>'job_id')::uuid IS NOT DISTINCT FROM b.job_id
  AND e.metadata->'placement_repaired'->'prior'->>'attribution_status' IS NOT DISTINCT FROM b.attribution_status
  AND e.metadata->'placement_repaired'->'prior'->>'match_method' IS NOT DISTINCT FROM b.match_method;
 IF n <> want THEN RAISE EXCEPTION 'placement_misfile_repair: % of % rows saved their prior state; refusing', n, want; END IF;
 -- Nothing but the placement columns, the contact and the named metadata keys moved.
 SELECT count(*) INTO n FROM public.business_events e JOIN mr_before b ON b.id = e.id
 WHERE md5(e.payload::text) IS DISTINCT FROM b.payload_md5 OR e.event_type IS DISTINCT FROM b.event_type
  OR e.source IS DISTINCT FROM b.source OR e.channel IS DISTINCT FROM b.channel OR e.direction IS DISTINCT FROM b.direction
  OR e.thread_key IS DISTINCT FROM b.thread_key OR e.occurred_at IS DISTINCT FROM b.occurred_at OR e.event_at IS DISTINCT FROM b.event_at
  OR e.recorded_at IS DISTINCT FROM b.recorded_at OR e.context_captured_at IS DISTINCT FROM b.context_captured_at
  OR e.body_preview IS DISTINCT FROM b.body_preview
  OR (e.metadata - ARRAY['party_roles', 'placement_repaired', 'capture_mode', 'capture_mode_before', 'placement_rule', 'payload_job_guess',
       'placement_guard_job_ids', 'placement_contactless_job_ids', 'placement_other_contact_job_ids', 'aftercare_unpaid_job_ids',
       'contact_recovered_by', 'identity_conflict', 'writer_unknown', 'ref_not_found'])
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

-- What this run did: by plan, the ladder's rule, the job's state today, and the party roles before -> after.
SELECT p.plan, e.attribution_status, e.metadata->>'placement_rule' AS rule,
 count(*) AS rows, count(DISTINCT e.contact_id) AS customers,
 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = e.job_id
   AND j.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost'))) AS on_live_job_today,
 count(*) FILTER (WHERE cardinality(e.candidate_job_ids) > 0) AS with_candidates,
 count(*) FILTER (WHERE coalesce(e.context_captured_at, e.recorded_at) > now() - interval '30 days') AS in_scorecard_window,
 string_agg(DISTINCT (b.metadata->'party_roles'->>'audience') || '->' || (e.metadata->'party_roles'->>'audience'), ' ') AS audience_before_after
FROM public.business_events e JOIN mr_plan p ON p.event_id = e.id JOIN mr_before b ON b.id = e.id
GROUP BY p.plan, e.attribution_status, e.metadata->>'placement_rule'
ORDER BY p.plan COLLATE "C", e.attribution_status COLLATE "C", (e.metadata->>'placement_rule') COLLATE "C";
SELECT (SELECT count(*) FROM public.context_payload_job_mismatch_rows()) AS known_misfiles_after;
ROLLBACK;
