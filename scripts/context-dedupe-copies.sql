-- Duplicate message rows on live jobs: census, guarded marking (dry run) and
-- the numbers to check (gap map W9, 6 Oct 2026). Pair with
-- scripts/context-dedupe-copies-undo.sql. Production: run each PART on its own.
--
-- What a copy is. The Opus S9 rule (story-review needs.sql S9) finds rows on a
-- live job with the same channel, direction and words as an earlier row
-- within 120 seconds. Read pair by pair on production on 6 Oct 2026 (read
-- only), those 334 rows (of 5,557 worded message rows) on 77 live jobs are
-- two kinds:
--   * 256 rows on 41 jobs are the SAME message saved twice (248 of them are
--     marked; see "Which row stays"). Proven by:
--       same_ghl_message (66): both rows name the same GHL message id
--         (ghl:<id> key, payload.ghl_message_id or payload.message_id): a
--         key-less older writer (ghl-proxy before keying, ops-api
--         backfill_ghl_conversations, the webhook receiver) and a keyed one;
--       same_email_other_mailbox (187): the old monitor-inbox path saved one
--         email once per mailbox it reached (same sender and subject,
--         different mailbox);
--       same_call_recording (3): the same recording transcribed twice
--         (same payload.recording_url_hash).
--   * 78 rows are NOT copies and are left alone: 58 pairs carry two different
--     GHL message ids (a customer's photos sent a minute apart, repeated
--     missed calls, one alert texted to several crew members), 8 are two
--     separate deliveries to one mailbox, 11 are staff notes with nothing
--     proving a double save, 1 is two outbound emails with different
--     internet message ids.
-- The writer fixes (migration 20261006031000, monitor-inbox/self_copy.ts) stop
-- new copies; this script marks the ones already saved.
--
-- Which row stays. A proven copy is marked only when its earlier partner can
-- stand in for it: the readers read the partner at least as fully (it is
-- admissible now, and captured when the copy is). Otherwise marking would
-- hide the message from a reader, so the pair is left alone (reported as
-- proven_left_unmarked). On 6 Oct 2026 that is 8 same_ghl_message pairs: an
-- ops-api backfill row never captured, then the history load's captured row.
--
-- What marking does. Each copy row gets metadata.duplicate_of = the id of the
-- row it copies (the earliest proven stand-in partner, never itself a copy) and
-- metadata.duplicate_marked = {by, rule, census, at}. Nothing else: no row is
-- deleted, moved off its job, re-placed or re-worded; the original is untouched.
-- Readers skip a marked row through context_event_source_admissible
-- (20261006031000): it never wakes a read, is never handed to the model, is
-- not in the catch-up set and is not ledger evidence. The revision store and
-- current_job_context_facts do not read the mark, so a fact or receipt that
-- already points at a copy stays resolvable and current (4 current facts cite
-- a copy today). One side effect, checked below: any metadata update re-runs
-- the party roles trigger, which re-stamps party_roles to the current
-- classifier (version party_roles_v1 to v2 on about 238 of the 248 rows); the
-- dry run refuses if the stamp changes in anything but its version. The undo
-- re-runs the same trigger, so it cannot put v1 back, and need not.
--
-- How to run (production: read only first, a write only with the owner's go).
--   PART 1  read-only census. Must show s9_copy_rows about 334 on about 77
--           jobs, and to_mark / to_mark_jobs. These drift: every live-job
--           status change and every new copy moves them. Before PART 2,
--           copy to_mark and to_mark_jobs into the two constants at the top of
--           its DO block. original_not_admissible_now must be 0.
--   PART 2  guarded marking. As written it ends in ROLLBACK: a dry run that
--           marks, checks and then throws the marks away. It refuses unless
--           the plan is exactly the expected rows and jobs, migration
--           20261006031000 is applied, no copy is already marked, every
--           original is on the copy's job, is not itself a copy and is still
--           admissible (before and after marking, so a copy is never marked
--           when its original is hidden), exactly that many rows were
--           updated, nothing but the mark changed, no
--           marked copy is admissible and every fact that was current stays
--           current. Its last statement prints the after-census. To apply for
--           real (owner's go only): change the final ROLLBACK to COMMIT and run
--           PART 2 once.
--   UNDO    scripts/context-dedupe-copies-undo.sql removes exactly these
--           marks (metadata.duplicate_marked.by = context_dedupe_copies_20261006).
--
-- Measured on production with PART 1 (read only, 6 Oct 2026, after the
-- stand-in rule): 5,571 worded message rows on live jobs; s9_copy_rows 334 on
-- 77 jobs; to_mark 248 on 41 jobs (same_email_other_mailbox 187,
-- same_ghl_message 58, same_call_recording 3); proven_left_unmarked 8;
-- original_is_copy 0; already marked 0; original_not_admissible_now 0; 3 of
-- the copies still unread; 238 read receipts and 4 current facts point at a
-- copy (both stay as they are); party_roles would change on 238 rows, all in
-- the version only. PART 2 has been run only on a disposable local database with
-- fixture rows of every kind (it marked the proven copies, left the rest,
-- refused a wrong count and a second run, and the undo cleared it); it has
-- never been run on production.
--
-- Text order never reaches output here (counts and json objects only).

-- ============================================================================
-- PART 1. Read-only census.
-- ============================================================================
BEGIN READ ONLY;
WITH live AS (
  SELECT j.id FROM public.jobs j
  WHERE j.status::text NOT IN ('cancelled','draft','archived','complete','completed','lost')
),
m AS (
  SELECT e.id, e.job_id, e.channel, e.direction, e.source, coalesce(e.event_at, e.occurred_at) AS t,
         md5(coalesce(e.payload->>'body', e.payload->>'message_text', e.payload->>'text', e.payload->>'note_text',
                      e.payload->>'note', e.payload->>'transcript', e.body_preview, '')) AS h,
         coalesce(substring(e.provider_message_id FROM '^ghl:(.+)$'), nullif(e.payload->>'ghl_message_id',''),
                  nullif(e.payload->>'message_id','')) AS gid,
         e.source IN ('monitor-inbox','monitor_inbox') AS old_path,
         nullif(lower(btrim(e.payload->>'mailbox')),'') AS mailbox,
         lower(btrim(e.payload->>'from')) AS sender, e.payload->>'subject' AS subject,
         nullif(e.payload->>'recording_url_hash','') AS recording
  FROM public.business_events e
  WHERE e.job_id IN (SELECT id FROM live) AND e.channel IN ('sms','email','call','note')
    AND length(coalesce(e.payload->>'body', e.payload->>'message_text', e.payload->>'text', e.payload->>'note_text',
                        e.payload->>'note', e.payload->>'transcript', e.body_preview, '')) > 0
),
-- The Opus S9 rule: same live job, channel, direction and words, within 120 s.
s9 AS (
  SELECT a.id AS original_id, b.id AS copy_id, b.job_id, b.channel, a.source AS first_source, b.source AS copy_source, a.t AS original_t,
   CASE
    WHEN a.gid IS NOT NULL AND a.gid = b.gid THEN 'same_ghl_message'
    WHEN a.old_path AND b.old_path AND a.channel = 'email' AND a.mailbox IS NOT NULL AND b.mailbox IS NOT NULL
     AND a.mailbox <> b.mailbox AND a.sender = b.sender AND a.subject IS NOT DISTINCT FROM b.subject THEN 'same_email_other_mailbox'
    WHEN a.recording IS NOT NULL AND a.recording = b.recording THEN 'same_call_recording'
    WHEN a.gid IS NOT NULL AND b.gid IS NOT NULL THEN 'not_copy:distinct_ghl_messages'
    WHEN a.old_path AND b.old_path AND a.mailbox IS NOT DISTINCT FROM b.mailbox THEN 'not_copy:two_deliveries_one_mailbox'
    WHEN a.channel = 'note' THEN 'not_copy:unproven_staff_note'
    ELSE 'not_copy:unproven' END AS rule
  FROM m a JOIN m b ON a.job_id = b.job_id AND a.channel = b.channel AND a.direction IS NOT DISTINCT FROM b.direction
   AND a.h = b.h AND (a.t < b.t OR (a.t = b.t AND a.id < b.id)) AND b.t - a.t <= interval '120 seconds'
),
-- One verdict per S9 copy row: proven when any of its pairs proves it.
verdict AS (
  SELECT DISTINCT ON (copy_id) copy_id, job_id, channel, first_source, copy_source, rule
  FROM s9 ORDER BY copy_id, (rule LIKE 'not_copy:%'), original_t, original_id
),
-- A proven pair whose earlier row can stand in for the later one: the
-- readers read it at least as fully (admissible now, and captured when the
-- later row is). Otherwise marking the later row would hide the message from
-- a reader, so that pair is left alone.
standin AS (
  SELECT s.* FROM s9 s
  JOIN public.business_events o ON o.id = s.original_id
  JOIN public.business_events c ON c.id = s.copy_id
  WHERE s.rule NOT LIKE 'not_copy:%' AND public.context_event_source_admissible(o)
    AND (o.context_captured_at IS NOT NULL OR c.context_captured_at IS NULL)
),
proven AS (SELECT DISTINCT copy_id FROM standin),
-- The row each proven copy is marked as a copy of: its earliest proven
-- stand-in partner that is not itself a proven copy.
plan AS (
  SELECT DISTINCT ON (s.copy_id) s.copy_id, s.original_id, s.job_id, s.rule,
   s.original_id IN (SELECT copy_id FROM proven) AS original_is_copy
  FROM standin s
  ORDER BY s.copy_id, (s.original_id IN (SELECT copy_id FROM proven)), s.original_t, s.original_id
)
SELECT jsonb_build_object(
 'message_rows_with_words', (SELECT count(*) FROM m),
 's9_copy_rows', (SELECT count(*) FROM verdict),
 's9_jobs', (SELECT count(DISTINCT job_id) FROM verdict),
 's9_by_channel', (SELECT jsonb_object_agg(channel, n) FROM (SELECT channel, count(*) n FROM verdict GROUP BY 1) x),
 's9_by_writer_pair', (SELECT jsonb_object_agg(first_source || ' > ' || copy_source, n)
   FROM (SELECT first_source, copy_source, count(*) n FROM verdict GROUP BY 1, 2) x),
 'by_rule', (SELECT jsonb_object_agg(rule, n) FROM (SELECT rule, count(*) n FROM verdict GROUP BY 1) x),
 'to_mark', (SELECT count(*) FROM plan),
 'proven_left_unmarked', (SELECT count(*) FROM verdict v WHERE v.rule NOT LIKE 'not_copy:%'
   AND v.copy_id NOT IN (SELECT copy_id FROM plan)),
 'to_mark_jobs', (SELECT count(DISTINCT job_id) FROM plan),
 'original_is_copy', (SELECT count(*) FROM plan WHERE original_is_copy),
 'already_marked_in_plan', (SELECT count(*) FROM public.business_events e JOIN plan p ON p.copy_id = e.id
   WHERE coalesce(e.metadata, '{}'::jsonb) ? 'duplicate_of'),
 'original_not_admissible_now', (SELECT count(*) FROM public.business_events o JOIN plan p ON p.original_id = o.id
   WHERE NOT public.context_event_source_admissible(o)),
 'marked_by_this_script', (SELECT count(*) FROM public.business_events e
   WHERE e.metadata -> 'duplicate_marked' ->> 'by' = 'context_dedupe_copies_20261006'),
 'unread_copies_today', (SELECT count(*) FROM public.context_unread_rows(ARRAY(SELECT DISTINCT job_id FROM plan)) u
   WHERE u.id IN (SELECT copy_id FROM plan)),
 'current_facts_citing_a_copy', (SELECT count(*) FROM public.current_job_context_facts v
   WHERE v.source_event_ids && ARRAY(SELECT copy_id FROM plan)),
 'receipts_on_copies', (SELECT count(*) FROM public.context_extraction_event_receipts r
   WHERE r.event_id IN (SELECT copy_id FROM plan)),
 'party_roles_stamp_would_change', (SELECT count(*) FROM public.business_events e JOIN plan p ON p.copy_id = e.id
   WHERE public.context_message_party_roles(e) IS DISTINCT FROM e.metadata -> 'party_roles'),
 'party_roles_would_change_beyond_version', (SELECT count(*) FROM public.business_events e JOIN plan p ON p.copy_id = e.id
   WHERE (public.context_message_party_roles(e) - 'version') IS DISTINCT FROM ((e.metadata -> 'party_roles') - 'version'))
) AS census;
ROLLBACK;

-- ============================================================================
-- PART 2. Guarded marking. Dry run: ends in ROLLBACK.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TEMP TABLE dedupe_plan ON COMMIT DROP AS
WITH live AS (
  SELECT j.id FROM public.jobs j
  WHERE j.status::text NOT IN ('cancelled','draft','archived','complete','completed','lost')
),
m AS (
  SELECT e.id, e.job_id, e.channel, e.direction, e.source, coalesce(e.event_at, e.occurred_at) AS t,
         md5(coalesce(e.payload->>'body', e.payload->>'message_text', e.payload->>'text', e.payload->>'note_text',
                      e.payload->>'note', e.payload->>'transcript', e.body_preview, '')) AS h,
         coalesce(substring(e.provider_message_id FROM '^ghl:(.+)$'), nullif(e.payload->>'ghl_message_id',''),
                  nullif(e.payload->>'message_id','')) AS gid,
         e.source IN ('monitor-inbox','monitor_inbox') AS old_path,
         nullif(lower(btrim(e.payload->>'mailbox')),'') AS mailbox,
         lower(btrim(e.payload->>'from')) AS sender, e.payload->>'subject' AS subject,
         nullif(e.payload->>'recording_url_hash','') AS recording
  FROM public.business_events e
  WHERE e.job_id IN (SELECT id FROM live) AND e.channel IN ('sms','email','call','note')
    AND length(coalesce(e.payload->>'body', e.payload->>'message_text', e.payload->>'text', e.payload->>'note_text',
                        e.payload->>'note', e.payload->>'transcript', e.body_preview, '')) > 0
),
-- The Opus S9 rule: same live job, channel, direction and words, within 120 s.
s9 AS (
  SELECT a.id AS original_id, b.id AS copy_id, b.job_id, b.channel, a.source AS first_source, b.source AS copy_source, a.t AS original_t,
   CASE
    WHEN a.gid IS NOT NULL AND a.gid = b.gid THEN 'same_ghl_message'
    WHEN a.old_path AND b.old_path AND a.channel = 'email' AND a.mailbox IS NOT NULL AND b.mailbox IS NOT NULL
     AND a.mailbox <> b.mailbox AND a.sender = b.sender AND a.subject IS NOT DISTINCT FROM b.subject THEN 'same_email_other_mailbox'
    WHEN a.recording IS NOT NULL AND a.recording = b.recording THEN 'same_call_recording'
    WHEN a.gid IS NOT NULL AND b.gid IS NOT NULL THEN 'not_copy:distinct_ghl_messages'
    WHEN a.old_path AND b.old_path AND a.mailbox IS NOT DISTINCT FROM b.mailbox THEN 'not_copy:two_deliveries_one_mailbox'
    WHEN a.channel = 'note' THEN 'not_copy:unproven_staff_note'
    ELSE 'not_copy:unproven' END AS rule
  FROM m a JOIN m b ON a.job_id = b.job_id AND a.channel = b.channel AND a.direction IS NOT DISTINCT FROM b.direction
   AND a.h = b.h AND (a.t < b.t OR (a.t = b.t AND a.id < b.id)) AND b.t - a.t <= interval '120 seconds'
),
-- One verdict per S9 copy row: proven when any of its pairs proves it.
verdict AS (
  SELECT DISTINCT ON (copy_id) copy_id, job_id, channel, first_source, copy_source, rule
  FROM s9 ORDER BY copy_id, (rule LIKE 'not_copy:%'), original_t, original_id
),
-- A proven pair whose earlier row can stand in for the later one: the
-- readers read it at least as fully (admissible now, and captured when the
-- later row is). Otherwise marking the later row would hide the message from
-- a reader, so that pair is left alone.
standin AS (
  SELECT s.* FROM s9 s
  JOIN public.business_events o ON o.id = s.original_id
  JOIN public.business_events c ON c.id = s.copy_id
  WHERE s.rule NOT LIKE 'not_copy:%' AND public.context_event_source_admissible(o)
    AND (o.context_captured_at IS NOT NULL OR c.context_captured_at IS NULL)
),
proven AS (SELECT DISTINCT copy_id FROM standin),
-- The row each proven copy is marked as a copy of: its earliest proven
-- stand-in partner that is not itself a proven copy.
plan AS (
  SELECT DISTINCT ON (s.copy_id) s.copy_id, s.original_id, s.job_id, s.rule,
   s.original_id IN (SELECT copy_id FROM proven) AS original_is_copy
  FROM standin s
  ORDER BY s.copy_id, (s.original_id IN (SELECT copy_id FROM proven)), s.original_t, s.original_id
)
SELECT p.copy_id, p.original_id, p.job_id, p.rule, p.original_is_copy FROM plan p;

CREATE TEMP TABLE dedupe_before ON COMMIT DROP AS
SELECT e.id, e.job_id, e.attribution_status, e.payload, e.provider_message_id, coalesce(e.metadata, '{}'::jsonb) AS metadata
FROM public.business_events e JOIN dedupe_plan p ON p.copy_id = e.id;

CREATE TEMP TABLE dedupe_facts_before ON COMMIT DROP AS
SELECT v.id FROM public.current_job_context_facts v WHERE v.source_event_ids && ARRAY(SELECT copy_id FROM dedupe_plan);

DO $mark$
DECLARE
 -- From PART 1 (to_mark, to_mark_jobs), read just before this run.
 expected_rows constant integer := 248;
 expected_jobs constant integer := 41;
 n integer; j integer; marked integer; bumped integer;
BEGIN
 SELECT count(*), count(DISTINCT job_id) INTO n, j FROM dedupe_plan;
 IF n <> expected_rows OR j <> expected_jobs THEN
  RAISE EXCEPTION 'dedupe_guard_count: the plan is % rows on % jobs, expected % on %; re-run PART 1 and update the two constants',
   n, j, expected_rows, expected_jobs;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_event_source_admissible(public.business_events)')
   AND p.prosrc LIKE '%duplicate_of%') THEN
  RAISE EXCEPTION 'dedupe_guard_reader: migration 20261006031000 is not applied; readers would not skip a marked copy';
 END IF;
 IF EXISTS (SELECT 1 FROM dedupe_plan WHERE original_is_copy) THEN
  RAISE EXCEPTION 'dedupe_guard_chain: a planned original is itself a copy';
 END IF;
 IF EXISTS (SELECT 1 FROM dedupe_plan p LEFT JOIN public.business_events o ON o.id = p.original_id
   WHERE o.id IS NULL OR o.job_id IS DISTINCT FROM p.job_id OR coalesce(o.metadata, '{}'::jsonb) ? 'duplicate_of') THEN
  RAISE EXCEPTION 'dedupe_guard_original: an original is missing, on another job, or marked';
 END IF;
 IF EXISTS (SELECT 1 FROM dedupe_before WHERE metadata ? 'duplicate_of' OR metadata ? 'duplicate_marked') THEN
  RAISE EXCEPTION 'dedupe_guard_marked: a planned copy is already marked';
 END IF;
 -- An original that is no longer read (retracted, or moved to a status that is
 -- not linked since the census) cannot stand in: marking its copy would hide
 -- the message from every reader. Refuse; re-run PART 1 after the repair.
 IF EXISTS (SELECT 1 FROM dedupe_plan p JOIN public.business_events o ON o.id = p.original_id
   WHERE NOT public.context_event_source_admissible(o)) THEN
  RAISE EXCEPTION 'dedupe_guard_original_hidden: an original is not admissible now; marking its copy would hide the message';
 END IF;

 UPDATE public.business_events e
 SET metadata = coalesce(e.metadata, '{}'::jsonb) || jsonb_build_object(
  'duplicate_of', p.original_id::text,
  'duplicate_marked', jsonb_build_object('by', 'context_dedupe_copies_20261006', 'rule', p.rule,
   'census', 'opus_s9_proven_v1', 'at', now()))
 FROM dedupe_plan p
 WHERE e.id = p.copy_id AND NOT (coalesce(e.metadata, '{}'::jsonb) ? 'duplicate_of');
 GET DIAGNOSTICS marked = ROW_COUNT;
 IF marked <> expected_rows THEN
  RAISE EXCEPTION 'dedupe_guard_written: % rows marked, expected %', marked, expected_rows;
 END IF;

 -- Nothing but the mark changed: job, placement, words, key, and every other
 -- metadata key; party_roles may only change its version (the trigger).
 IF EXISTS (SELECT 1 FROM dedupe_before b JOIN public.business_events e ON e.id = b.id
   WHERE e.job_id IS DISTINCT FROM b.job_id OR e.attribution_status IS DISTINCT FROM b.attribution_status
    OR e.payload IS DISTINCT FROM b.payload OR e.provider_message_id IS DISTINCT FROM b.provider_message_id
    OR (e.metadata - 'duplicate_of' - 'duplicate_marked' - 'party_roles') IS DISTINCT FROM (b.metadata - 'party_roles')
    OR ((e.metadata -> 'party_roles') - 'version') IS DISTINCT FROM ((b.metadata -> 'party_roles') - 'version')) THEN
  RAISE EXCEPTION 'dedupe_guard_side_effect: marking changed more than the mark';
 END IF;
 -- Readers skip every marked copy; every fact that was current stays current.
 IF EXISTS (SELECT 1 FROM public.business_events e JOIN dedupe_plan p ON p.copy_id = e.id
   WHERE public.context_event_source_admissible(e)) THEN
  RAISE EXCEPTION 'dedupe_guard_reader: a marked copy is still admissible';
 END IF;
 IF EXISTS (SELECT 1 FROM dedupe_plan p JOIN public.business_events o ON o.id = p.original_id
   WHERE NOT public.context_event_source_admissible(o)) THEN
  RAISE EXCEPTION 'dedupe_guard_original_hidden: after marking, an original is not admissible';
 END IF;
 IF (SELECT count(*) FROM public.current_job_context_facts v WHERE v.id IN (SELECT id FROM dedupe_facts_before))
   <> (SELECT count(*) FROM dedupe_facts_before) THEN
  RAISE EXCEPTION 'dedupe_guard_facts: a current fact citing a copy stopped being current';
 END IF;
 SELECT count(*) INTO bumped FROM dedupe_before b JOIN public.business_events e ON e.id = b.id
  WHERE e.metadata -> 'party_roles' IS DISTINCT FROM b.metadata -> 'party_roles';
 RAISE NOTICE 'dedupe: marked % copies on % jobs; party_roles re-stamped (version only) on % rows', marked, j, bumped;
END $mark$;

-- After-census, inside the same transaction: the S9 rule over rows that are
-- not marked (what the readers now see), the marks by rule, and the facts.
WITH live AS (
  SELECT j.id FROM public.jobs j
  WHERE j.status::text NOT IN ('cancelled','draft','archived','complete','completed','lost')
),
m AS (
  SELECT e.id, e.job_id, e.channel, e.direction, e.source, coalesce(e.event_at, e.occurred_at) AS t,
         md5(coalesce(e.payload->>'body', e.payload->>'message_text', e.payload->>'text', e.payload->>'note_text',
                      e.payload->>'note', e.payload->>'transcript', e.body_preview, '')) AS h,
         coalesce(substring(e.provider_message_id FROM '^ghl:(.+)$'), nullif(e.payload->>'ghl_message_id',''),
                  nullif(e.payload->>'message_id','')) AS gid,
         e.source IN ('monitor-inbox','monitor_inbox') AS old_path,
         nullif(lower(btrim(e.payload->>'mailbox')),'') AS mailbox,
         lower(btrim(e.payload->>'from')) AS sender, e.payload->>'subject' AS subject,
         nullif(e.payload->>'recording_url_hash','') AS recording
  FROM public.business_events e
  WHERE e.job_id IN (SELECT id FROM live) AND e.channel IN ('sms','email','call','note')
    AND length(coalesce(e.payload->>'body', e.payload->>'message_text', e.payload->>'text', e.payload->>'note_text',
                        e.payload->>'note', e.payload->>'transcript', e.body_preview, '')) > 0
    AND NOT (coalesce(e.metadata, '{}'::jsonb) ? 'duplicate_of')
),
-- The Opus S9 rule: same live job, channel, direction and words, within 120 s.
s9 AS (
  SELECT a.id AS original_id, b.id AS copy_id, b.job_id, b.channel, a.source AS first_source, b.source AS copy_source, a.t AS original_t,
   CASE
    WHEN a.gid IS NOT NULL AND a.gid = b.gid THEN 'same_ghl_message'
    WHEN a.old_path AND b.old_path AND a.channel = 'email' AND a.mailbox IS NOT NULL AND b.mailbox IS NOT NULL
     AND a.mailbox <> b.mailbox AND a.sender = b.sender AND a.subject IS NOT DISTINCT FROM b.subject THEN 'same_email_other_mailbox'
    WHEN a.recording IS NOT NULL AND a.recording = b.recording THEN 'same_call_recording'
    WHEN a.gid IS NOT NULL AND b.gid IS NOT NULL THEN 'not_copy:distinct_ghl_messages'
    WHEN a.old_path AND b.old_path AND a.mailbox IS NOT DISTINCT FROM b.mailbox THEN 'not_copy:two_deliveries_one_mailbox'
    WHEN a.channel = 'note' THEN 'not_copy:unproven_staff_note'
    ELSE 'not_copy:unproven' END AS rule
  FROM m a JOIN m b ON a.job_id = b.job_id AND a.channel = b.channel AND a.direction IS NOT DISTINCT FROM b.direction
   AND a.h = b.h AND (a.t < b.t OR (a.t = b.t AND a.id < b.id)) AND b.t - a.t <= interval '120 seconds'
),
-- One verdict per S9 copy row: proven when any of its pairs proves it.
verdict AS (
  SELECT DISTINCT ON (copy_id) copy_id, job_id, channel, first_source, copy_source, rule
  FROM s9 ORDER BY copy_id, (rule LIKE 'not_copy:%'), original_t, original_id
),
-- A proven pair whose earlier row can stand in for the later one: the
-- readers read it at least as fully (admissible now, and captured when the
-- later row is). Otherwise marking the later row would hide the message from
-- a reader, so that pair is left alone.
standin AS (
  SELECT s.* FROM s9 s
  JOIN public.business_events o ON o.id = s.original_id
  JOIN public.business_events c ON c.id = s.copy_id
  WHERE s.rule NOT LIKE 'not_copy:%' AND public.context_event_source_admissible(o)
    AND (o.context_captured_at IS NOT NULL OR c.context_captured_at IS NULL)
),
proven AS (SELECT DISTINCT copy_id FROM standin),
-- The row each proven copy is marked as a copy of: its earliest proven
-- stand-in partner that is not itself a proven copy.
plan AS (
  SELECT DISTINCT ON (s.copy_id) s.copy_id, s.original_id, s.job_id, s.rule,
   s.original_id IN (SELECT copy_id FROM proven) AS original_is_copy
  FROM standin s
  ORDER BY s.copy_id, (s.original_id IN (SELECT copy_id FROM proven)), s.original_t, s.original_id
)
SELECT jsonb_build_object(
 'unmarked_message_rows_with_words', (SELECT count(*) FROM m),
 's9_copy_rows_left', (SELECT count(*) FROM verdict),
 's9_jobs_left', (SELECT count(DISTINCT job_id) FROM verdict),
 'left_by_rule', (SELECT jsonb_object_agg(rule, n) FROM (SELECT rule, count(*) n FROM verdict GROUP BY 1) x),
 'marked', (SELECT count(*) FROM public.business_events e WHERE e.metadata -> 'duplicate_marked' ->> 'by' = 'context_dedupe_copies_20261006'),
 'marked_by_rule', (SELECT jsonb_object_agg(r, n) FROM (SELECT e.metadata -> 'duplicate_marked' ->> 'rule' AS r, count(*) n
   FROM public.business_events e WHERE e.metadata -> 'duplicate_marked' ->> 'by' = 'context_dedupe_copies_20261006' GROUP BY 1) x),
 'marked_jobs', (SELECT count(DISTINCT e.job_id) FROM public.business_events e
   WHERE e.metadata -> 'duplicate_marked' ->> 'by' = 'context_dedupe_copies_20261006'),
 'current_facts_citing_a_copy', (SELECT count(*) FROM public.current_job_context_facts v WHERE v.id IN (SELECT id FROM dedupe_facts_before))
) AS after_census;

ROLLBACK;
