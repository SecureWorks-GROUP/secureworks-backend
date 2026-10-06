-- Old crew and staff texts: re-stamp their party roles with the v3 classifier
-- (migration 20261006034000_context_party_roles_health, 6 Oct 2026). Pair with
-- scripts/context-party-roles-v3-backfill-undo.sql. Production: run each PART
-- on its own, and only after the migration is applied.
--
-- Not run by its author. PART 1 is READ ONLY. PART 2 is the WRITE, a dry run:
-- as written it ends in ROLLBACK and changes nothing.
--
-- What it fixes. Before the ladder's L1d rule (5 Oct 2026) our own crew and
-- staff notification texts ("New job assigned:", "Job ready for crew:", "New
-- make-safe:", "New repair:" to crew; "Docs Ready: ", "SecureWorks: New
-- make-safe " and its roof report wording "SecureWorks: New roof report
-- make-safe " to the office) were stamped from the contact they went to.
-- Where a crew member's or office person's GHL contact is also a job's client
-- on file, they read as messages to a customer; where the contact was
-- unknown, as unknown. The v3 classifier reads them as staff to crew or staff
-- (basis our_template, audience internal). The trigger stamps v3 on every new
-- row and re-stamps a stored row whenever a writer updates one of its columns
-- (job_id, contact_id, direction, metadata, payload, event_type, channel: a
-- relink, a dedupe mark); every other stored row keeps its old stamp until
-- this script. It re-stamps exactly the rows whose roles or audience v3 would
-- change. Rows that only gain the new basis name (same roles, same audience)
-- are left alone. A row a writer re-stamped before this script runs carries
-- v3 without this run's keys: it is no longer a candidate, and the undo
-- leaves it alone.
--
-- What the write does. On each row it writes two metadata keys:
-- party_roles_prior_v3 = the stamp as it was (for the undo) and
-- party_roles_v3_backfill = the run id. The live trigger
-- context_party_roles_business_event fires on that metadata write and stamps
-- metadata.party_roles with the v3 classifier, exactly as it does for a new
-- row, so the backfill can never disagree with capture. Nothing else moves:
-- job_id, every attribution and match column, contact, direction, payload and
-- every other metadata key are checked unchanged before the batch is accepted
-- (the ladder runs on insert only, so no row is re-placed). No row is deleted,
-- moved, re-read by the model or sent. The keys of the earlier v2 backfill
-- (party_roles_prior, party_roles_v2_backfill) are left as they are.
--
-- Measured on production (read only, 6 Oct 2026, Perth afternoon), with the
-- v3 rule emulated in SQL because the migration was not applied yet: 608
-- rows, all from ghl-proxy, all captured between 6 Jul and 23 Sep 2026, none
-- on a live job (166 on one cancelled job, 5 on one archived job, 437 on no
-- job). All 608 are in the scorecard's crew and staff lane once the migration
-- is applied (its lane rule reads our templates as the classifier does):
--   to crew   358 rows: 196 customer -> crew (any_job_customer), 83 unknown
--             -> crew (no_match), 26 unknown -> crew (conflict), 53 staff ->
--             crew (a contact's later staff marker);
--   to staff  250 rows: 166 customer -> staff (job_customer, the cancelled
--             job), 76 customer -> staff (any_job_customer), and the 8 roof
--             report make-safe alerts (4 customer -> staff, 4 unknown ->
--             staff).
-- 113 of them carry the earlier v2 backfill's keys (left as they are). Row 2
-- of the scorecard does not move: the crew lane is graded on rows captured
-- since 4 Oct, and none of these is in the texts lane any more. What changes
-- is that 442 of our own notifications stop reading as messages to a
-- customer and 113 stop reading as unknown.
--
-- How to run (production: read only first, a write only with the owner's go).
--   PART 1  read-only census. Must show the migration live and the candidate
--           count by lane and old -> new (about 608 today; it only shrinks,
--           because new rows are stamped by v3 as they arrive and a row a
--           writer updates is re-stamped by v3 then). Copy this_batch into
--           expected_rows in PART 2 (it is capped at batch_size).
--   PART 2  guarded re-stamp of one batch, newest first. As written it ends
--           in ROLLBACK: a dry run that re-stamps, checks and throws it away.
--           It refuses unless v3 and the trigger are live, the batch is
--           exactly expected_rows (a writer re-stamping a candidate between
--           PART 1 and PART 2 makes it refuse: re-run PART 1), every row
--           comes out stamped v3 with basis our_template and audience
--           internal and the old stamp saved, and nothing but party_roles and
--           the two backfill keys moved. Its last statement prints the
--           batch's before -> after by lane. To apply (owner's go only):
--           change the final ROLLBACK to COMMIT and run PART 2 once; repeat
--           PART 1 and PART 2 until PART 1 reports 0.
--   UNDO    scripts/context-party-roles-v3-backfill-undo.sql puts back the
--           saved stamp on every row this run id touched.

-- ============================================================================
-- PART 1. READ ONLY.
-- ============================================================================
BEGIN READ ONLY;
SET LOCAL statement_timeout = '300s';

-- 0. Preconditions: v3 is the live classifier and its trigger is enabled.
SELECT
 coalesce(obj_description(to_regprocedure('public.context_message_party_roles(public.business_events)'),'pg_proc'),'')
  LIKE 'Party roles v3 (20261006034000):%' AS classifier_is_v3,
 EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.business_events'::regclass AND t.tgname='context_party_roles_business_event'
  AND NOT t.tgisinternal AND t.tgenabled<>'D') AS trigger_enabled;

-- 1. The candidates by lane and old -> new.
WITH tmpl AS MATERIALIZED (
 -- Our crew and staff templates on texts, the roof report make-safe alert
 -- included as v3 reads it (the cheap filter runs first).
 SELECT e.id FROM public.business_events e
 WHERE e.metadata ? 'party_roles'
  AND (e.channel='sms' OR (e.channel IS NULL AND e.event_type IN ('client.sms_out','sms_sent')))
  AND NOT (e.metadata ? 'party_roles_v3_backfill')
  AND (public.context_internal_text_role(e) IN ('crew','staff')
   OR btrim(public.context_event_text(e)) ~ '^SecureWorks: New roof report make-safe ')
), cand AS MATERIALIZED (
 SELECT e.id, e.job_id, e.source, coalesce(e.context_captured_at,e.recorded_at) AS cap,
  public.context_scorecard_lane_of(e.event_type,e.source,e.channel,e.direction,e.body_preview,e.metadata) AS lane,
  e.metadata->'party_roles' AS old_pr, public.context_message_party_roles(e) AS new_pr, e.metadata ? 'party_roles_v2_backfill' AS had_v2
 FROM public.business_events e JOIN tmpl ON tmpl.id=e.id
)
SELECT lane, source, (old_pr->>'sender_role')||' -> '||(old_pr->>'recipient_role') AS old_pair, old_pr->>'basis' AS old_basis,
 (new_pr->>'sender_role')||' -> '||(new_pr->>'recipient_role') AS new_pair, new_pr->>'basis' AS new_basis,
 count(*) AS rows, count(*) FILTER (WHERE had_v2) AS with_v2_backfill_keys, count(*) FILTER (WHERE job_id IS NOT NULL) AS on_a_job,
 min(cap)::date AS first_captured, max(cap)::date AS last_captured
FROM cand
WHERE (old_pr->>'sender_role',old_pr->>'recipient_role',old_pr->>'counterpart_role',old_pr->>'audience')
  IS DISTINCT FROM (new_pr->>'sender_role',new_pr->>'recipient_role',new_pr->>'counterpart_role',new_pr->>'audience')
GROUP BY 1,2,3,4,5,6
ORDER BY lane COLLATE "C", count(*) DESC, (old_pr->>'basis') COLLATE "C", source COLLATE "C",
 ((old_pr->>'sender_role')||' -> '||(old_pr->>'recipient_role')) COLLATE "C",
 ((new_pr->>'sender_role')||' -> '||(new_pr->>'recipient_role')) COLLATE "C", (new_pr->>'basis') COLLATE "C";

-- 2. How many remain, and the next batch (copy this_batch into PART 2).
WITH tmpl AS MATERIALIZED (
 SELECT e.id FROM public.business_events e
 WHERE e.metadata ? 'party_roles'
  AND (e.channel='sms' OR (e.channel IS NULL AND e.event_type IN ('client.sms_out','sms_sent')))
  AND NOT (e.metadata ? 'party_roles_v3_backfill')
  AND (public.context_internal_text_role(e) IN ('crew','staff')
   OR btrim(public.context_event_text(e)) ~ '^SecureWorks: New roof report make-safe ')
), cand AS MATERIALIZED (
 SELECT e.metadata->'party_roles' AS old_pr, public.context_message_party_roles(e) AS new_pr
 FROM public.business_events e JOIN tmpl ON tmpl.id=e.id
)
SELECT count(*) AS remaining, least(count(*),1000) AS this_batch
FROM cand
WHERE (old_pr->>'sender_role',old_pr->>'recipient_role',old_pr->>'counterpart_role',old_pr->>'audience')
  IS DISTINCT FROM (new_pr->>'sender_role',new_pr->>'recipient_role',new_pr->>'counterpart_role',new_pr->>'audience');
ROLLBACK;

-- ============================================================================
-- PART 2. WRITE (dry run). One batch of at most 1000 rows, newest first.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

DO $pre$
BEGIN
 IF coalesce(obj_description(to_regprocedure('public.context_message_party_roles(public.business_events)'),'pg_proc'),'')
   NOT LIKE 'Party roles v3 (20261006034000):%'
  OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.business_events'::regclass
   AND t.tgname='context_party_roles_business_event' AND NOT t.tgisinternal AND t.tgenabled<>'D')
 THEN RAISE EXCEPTION 'party_roles_v3_backfill: migration 20261006034000 is not live (v3 classifier or trigger missing); refusing'; END IF;
END $pre$;

CREATE TEMP TABLE pr3_batch ON COMMIT DROP AS
WITH tmpl AS MATERIALIZED (
 SELECT e.id FROM public.business_events e
 WHERE e.metadata ? 'party_roles'
  AND (e.channel='sms' OR (e.channel IS NULL AND e.event_type IN ('client.sms_out','sms_sent')))
  AND NOT (e.metadata ? 'party_roles_v3_backfill')
  AND (public.context_internal_text_role(e) IN ('crew','staff')
   OR btrim(public.context_event_text(e)) ~ '^SecureWorks: New roof report make-safe ')
), cand AS MATERIALIZED (
 SELECT e.id, public.context_message_party_roles(e) AS new_pr FROM public.business_events e JOIN tmpl ON tmpl.id=e.id
)
SELECT e.id, e.job_id, e.attribution_status, e.attribution_step, e.attribution_confidence, e.match_status, e.match_method,
 e.candidate_job_ids, e.contact_id, e.direction, e.channel, e.event_type, md5(e.payload::text) AS payload_md5, e.metadata AS metadata_before,
 public.context_scorecard_lane_of(e.event_type,e.source,e.channel,e.direction,e.body_preview,e.metadata) AS lane
FROM public.business_events e JOIN cand c ON c.id=e.id
WHERE (e.metadata->'party_roles'->>'sender_role',e.metadata->'party_roles'->>'recipient_role',
       e.metadata->'party_roles'->>'counterpart_role',e.metadata->'party_roles'->>'audience')
  IS DISTINCT FROM (c.new_pr->>'sender_role',c.new_pr->>'recipient_role',c.new_pr->>'counterpart_role',c.new_pr->>'audience')
ORDER BY coalesce(e.event_at,e.occurred_at) DESC NULLS LAST, e.id
LIMIT 1000
FOR UPDATE OF e;

DO $count$
DECLARE
 -- The this_batch figure PART 1 printed (608 on 6 Oct 2026). The write refuses on any other count.
 expected_rows constant integer := 608;
 n integer;
BEGIN
 SELECT count(*) INTO n FROM pr3_batch;
 IF n <> expected_rows THEN
  RAISE EXCEPTION 'party_roles_v3_backfill: the batch is % rows, expected %; re-run PART 1 and copy this_batch',n,expected_rows;
 END IF;
END $count$;

UPDATE public.business_events e
SET metadata=e.metadata||jsonb_build_object('party_roles_prior_v3',b.metadata_before->'party_roles',
 'party_roles_v3_backfill','context_party_roles_v3_backfill_20261006')
FROM pr3_batch b WHERE e.id=b.id;

DO $check$
DECLARE n integer; moved integer; bad integer; want integer:=(SELECT count(*) FROM pr3_batch);
BEGIN
 -- Every row came out stamped by v3 as one of our notifications, the old stamp saved.
 SELECT count(*) INTO n FROM public.business_events e JOIN pr3_batch b ON b.id=e.id
 WHERE e.metadata->>'party_roles_v3_backfill'='context_party_roles_v3_backfill_20261006'
  AND e.metadata->'party_roles_prior_v3'=b.metadata_before->'party_roles'
  AND e.metadata->'party_roles'->>'version'='party_roles_v3'
  AND e.metadata->'party_roles'->>'basis'='our_template'
  AND e.metadata->'party_roles'->>'sender_role'='staff'
  AND e.metadata->'party_roles'->>'recipient_role' IN ('crew','staff')
  AND e.metadata->'party_roles'->>'audience'='internal';
 IF n<>want THEN RAISE EXCEPTION 'party_roles_v3_backfill: % of % rows came out stamped v3 our_template with the old stamp saved; refusing',n,want; END IF;
 -- Nothing but party_roles and the two backfill keys moved.
 SELECT count(*) INTO moved FROM public.business_events e JOIN pr3_batch b ON b.id=e.id
 WHERE e.job_id IS DISTINCT FROM b.job_id OR e.attribution_status IS DISTINCT FROM b.attribution_status
  OR e.attribution_step IS DISTINCT FROM b.attribution_step OR e.attribution_confidence IS DISTINCT FROM b.attribution_confidence
  OR e.match_status IS DISTINCT FROM b.match_status OR e.match_method IS DISTINCT FROM b.match_method
  OR e.candidate_job_ids IS DISTINCT FROM b.candidate_job_ids OR e.contact_id IS DISTINCT FROM b.contact_id
  OR e.direction IS DISTINCT FROM b.direction OR e.channel IS DISTINCT FROM b.channel OR e.event_type IS DISTINCT FROM b.event_type
  OR md5(e.payload::text) IS DISTINCT FROM b.payload_md5
  OR (e.metadata-'party_roles'-'party_roles_prior_v3'-'party_roles_v3_backfill') IS DISTINCT FROM (b.metadata_before-'party_roles');
 IF moved<>0 THEN RAISE EXCEPTION 'party_roles_v3_backfill: % rows changed beyond party_roles; refusing',moved; END IF;
 -- The ladder's labels are never overridden.
 SELECT count(*) INTO bad FROM public.business_events e JOIN pr3_batch b ON b.id=e.id
 WHERE nullif(e.metadata->>'audience','') IS NOT NULL AND e.metadata->'party_roles'->>'audience' IS DISTINCT FROM e.metadata->>'audience';
 IF bad<>0 THEN RAISE EXCEPTION 'party_roles_v3_backfill: % rows disagree with the ladder''s audience; refusing',bad; END IF;
END $check$;

-- The batch's before -> after (what this run stamped), by lane.
SELECT b.lane, (b.metadata_before->'party_roles'->>'sender_role')||' -> '||(b.metadata_before->'party_roles'->>'recipient_role') AS old_pair,
 b.metadata_before->'party_roles'->>'basis' AS old_basis,
 (e.metadata->'party_roles'->>'sender_role')||' -> '||(e.metadata->'party_roles'->>'recipient_role') AS new_pair,
 e.metadata->'party_roles'->>'basis' AS new_basis, count(*) AS rows
FROM public.business_events e JOIN pr3_batch b ON b.id=e.id
GROUP BY 1,2,3,4,5 ORDER BY b.lane COLLATE "C", count(*) DESC, (b.metadata_before->'party_roles'->>'basis') COLLATE "C",
 ((b.metadata_before->'party_roles'->>'sender_role')||' -> '||(b.metadata_before->'party_roles'->>'recipient_role')) COLLATE "C",
 ((e.metadata->'party_roles'->>'sender_role')||' -> '||(e.metadata->'party_roles'->>'recipient_role')) COLLATE "C",
 (e.metadata->'party_roles'->>'basis') COLLATE "C";
ROLLBACK;
