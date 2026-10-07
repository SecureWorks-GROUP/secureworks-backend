-- Stored message rows: re-stamp their party roles with the v4 classifier
-- (migration 20261007060000_context_party_roles_v4, 7 Oct 2026). Pair with
-- scripts/context-party-roles-v4-backfill-undo.sql. Production: run each PART
-- on its own, and only after the migration is applied.
--
-- Not run by its author. PART 1 is READ ONLY. PART 2 is the WRITE, a dry run:
-- as written it ends in ROLLBACK and changes nothing.
--
-- What it fixes. The trigger context_party_roles_business_event stamps a row
-- on insert and re-stamps it whenever a writer updates job_id, contact_id,
-- direction, metadata, payload, event_type or channel; every other stored row
-- keeps the stamp the classifier of its day gave it (7 Oct 2026: 11,619 rows
-- v1, 7,087 v2, 296 v3), and the scorecard's row 2 reads stored stamps. This
-- script re-stamps exactly the message rows whose sender, recipient,
-- counterpart or audience the live classifier reads differently: v4's new
-- readings (prospects with an open opportunity in the CRM, councils,
-- suppliers by our material orders and Xero bills, builders by their company
-- domains, transcripts as their calls) and the older ones no writer ever
-- reached (v3's crew and staff templates: scripts/context-party-roles-v3-backfill.sql
-- never ran, and it refuses once v4 is live). A row that would only gain a
-- new basis or version name (same roles, same audience) is left alone.
--
-- What the write does. On each row it writes two metadata keys:
-- party_roles_prior_v4 = the stamp as it was before this run first touched
-- the row (JSON null for a row that had none; a later batch never overwrites
-- it) and party_roles_v4_backfill = the run id. The live trigger fires on
-- that metadata write and stamps metadata.party_roles with the live
-- classifier, exactly as it does for a new row, so the backfill can never
-- disagree with capture. Nothing else moves: job_id, every attribution and
-- match column, contact, direction, channel, event type, payload and every
-- other metadata key are checked unchanged before the batch is accepted (the
-- ladder's trigger runs on insert only, so no row is re-placed). No row is
-- deleted, moved, read by a model or sent. The keys of the earlier v2
-- backfill (party_roles_prior, party_roles_v2_backfill) are left as they are.
--
-- Order. A row's reading can depend on other rows' stamps: the CRM rule reads
-- the crew and staff stamps on a contact's other rows, and a call transcript
-- reads its call's stamp. A batch therefore writes in three statements:
-- first the rows our own label or templates decide (rules 1 and 1b, which
-- read no other row), then every other row but call transcripts, then call
-- transcripts; a later statement sees an earlier one's stamps, and a batch
-- row whose reading moved after its own write is written once more before
-- the checks. Repeat PART 1 and PART 2 until PART 1 reports 0. A row whose
-- reading moves again later (another batch's stamp, an opportunity opened or
-- closed when the CRM roster refreshes) is a candidate again and keeps the
-- first stamp it saved.
--
-- Cost. Each PART reads every message row through the classifier once
-- (18,998 rows on 7 Oct 2026; v3 took 5.8 s per 1,000, and v4 reads more for
-- the rows v1's rules leave unknown), so each runs for minutes: run it with
-- psql, not the SQL editor or the API, whose requests stop sooner. That pass
-- takes no lock. PART 2 locks only its batch (at most 1,000 rows), and only
-- while it re-reads, writes and checks them (well under a minute); a writer
-- that updates one of them meanwhile waits for it, so run it in the Perth
-- evening.
--
-- Measured on production (read only, 7 Oct 2026), with v4 emulated in SQL
-- because the migration was not applied yet; message rows in the
-- scorecard's lanes:
--   captured in the last 30 days (19:00 Perth read), 818 rows: texts 324
--   (319 to or from a customer by an open opportunity; 5 to crew,
--   writer_marked_contact), calls 45 (44 open opportunity, 1 now conflict),
--   call transcripts 49 (48 open opportunity, 1 now conflict), emails in 244
--   (84 supplier by our order address, 32 by its domain, 73 by a Xero bill,
--   47 councils, 8 builder domain), emails out 96 (68 supplier order
--   address, 18 order domain, 8 councils, 1 prospect, 1 builder domain),
--   crew and staff texts 60 (our_template); 226 of them on a job (supplier,
--   council and builder mail about a job, our crew texts; a prospect is read
--   only on a row on no job). Captured earlier (13:55 Perth read), 888 rows:
--   call transcripts 190, crew and staff texts 538 (our_template), emails in
--   14, emails out 8, texts 138. Message rows outside the scorecard's lanes
--   (old call_complete rows, texts written with no channel, make-safe
--   reconcile mail) are candidates too when their reading changes; PART 1
--   counts them exactly.
-- After the full run the scorecard's row 2, 30 days by capture time, reads
-- (a second read, 21:20 Perth): texts 4,153 -> 4,473 of 4,680 (88.7% ->
-- 95.6%), calls 1,201 -> 1,244 of 1,354 (88.7% -> 91.9%), call transcripts
-- 279 -> 326 of 442 (63.1% -> 73.8%), emails in 1,458 -> 1,702 of 2,144
-- (68.0% -> 79.4%), emails out 544 -> 640 of 690 (78.8% -> 92.8%), crew and
-- staff texts 222 -> 234 of 234 (94.9% -> 100%). 2 rows go from known to
-- conflict (1 call, 1 transcript: the signals disagree).
-- Those shares are a one-time high, not what the lanes keep. A new row is
-- read when it is captured (and again only when a writer updates it), and
-- two of v4's signals often reach our records only after the message: a
-- prospect's opportunity (13 texts, 11 calls and 5 transcripts of the window
-- came before it was created, 80 texts, 5 calls and 10 transcripts less than
-- a day after; the roster cache is refreshed only when the sales booking
-- page loads) and a supplier's Xero bill (48 of the 84 bill emails came
-- before the bill reached our Xero copy). Read at capture the window reads:
-- texts 4,460 (95.3%) with a roster refreshed for every message, 4,380
-- (93.6%) with one a day old, and fewer with the rosters as they are
-- refreshed today (on no schedule), so amber; calls 1,233 to 1,228 (91.1% to
-- 90.7%); call transcripts 321 to 311 (72.6% to 70.4%); emails in 1,657
-- (77.3%); emails out 639 (92.6%); crew and staff texts 234 (100%). The
-- re-stamped shares drift down to those over the 30 days after it, unless
-- recent unknown rows are re-stamped on a schedule (behind its own switch,
-- created off: a live-data change, the owner's yes) or the capture side
-- changes (a roster refreshed on a schedule, the Xero bill sync run sooner
-- after a bill email).
-- It also moves row 3 (customer messages placed on a job, read from
-- party_roles.audience): 410 prospect messages, none on a job, become
-- customer messages with no job yet, so the live scorecard's row 3 reads
-- 4,723 of 6,592 (71.6%) instead of 4,723 of 6,182 (76.4%) until the
-- scorecard leaves customers with no job out of that denominator (scorecard
-- v2: no_job_customers - no_job_customers_on_a_job from
-- context_party_roles_lanes). PART 2 therefore refuses any batch that lowers
-- row 3 as the live scorecard reads it, unless owner_accepts_row3_drop is set
-- on the owner's yes: run the re-stamp together with or after that scorecard
-- change, or with his yes to the drop. (The migration alone moves row 3 the
-- same way, more slowly: new prospect messages read customer at capture,
-- about 10 to 13 a day, so row 3 reads about 72 to 73% after 30 days.)
--
-- How to run (production: read only first, a write only with the owner's go).
--   PART 1  read-only census. Must show the migration live, then the total
--           candidates and this_batch on its first row, and the candidates by
--           lane and old -> new below it (row3_no_job: how many join row 3's
--           customers with no job), then row 2 as stored now, then row 3 as
--           the live scorecard reads it now. Copy this_batch into
--           expected_rows in PART 2 (it is capped at 1000).
--   PART 2  guarded re-stamp of one batch. As written it ends in ROLLBACK: a
--           dry run that re-stamps, checks and throws it away. It refuses
--           unless v4 and the trigger are live, the batch is exactly
--           expected_rows (a writer re-stamping a candidate between PART 1
--           and PART 2 makes it refuse: re-run PART 1), every row comes out
--           stamped by the live classifier with its first stamp saved, the
--           ladder's audience is never overridden, nothing but party_roles
--           and the two backfill keys moved, and row 3 as the live scorecard
--           reads it is not lowered (unless owner_accepts_row3_drop is set on
--           the owner's yes; the refusal names row 3 before and after). It
--           prints the batch's before -> after by lane, then row 3 before ->
--           after. To apply (owner's go only): change the final ROLLBACK to
--           COMMIT and run PART 2 once; repeat PART 1 and PART 2 until PART 1
--           reports 0.
--   UNDO    scripts/context-party-roles-v4-backfill-undo.sql puts back the
--           saved stamp on every row this run id touched.

-- ============================================================================
-- PART 1. READ ONLY.
-- ============================================================================
BEGIN READ ONLY;
SET LOCAL statement_timeout = '1800s';

-- 0. Preconditions: v4 is the live classifier and its trigger is enabled.
SELECT
 coalesce(obj_description(to_regprocedure('public.context_message_party_roles(public.business_events)'),'pg_proc'),'')
  LIKE 'Party roles v4 (20261007060000):%' AS classifier_is_v4,
 EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.business_events'::regclass AND t.tgname='context_party_roles_business_event'
  AND NOT t.tgisinternal AND t.tgenabled<>'D') AS trigger_enabled;

-- 1. The candidates: the total and the next batch on the first row (lane
-- "(all)"), then by lane and old -> new. One pass over every message row.
WITH msg AS MATERIALIZED (
 -- Message rows, as the classifier names them (its own first test).
 SELECT e.id FROM public.business_events e
 WHERE coalesce(e.channel,'') IN ('sms','email','call')
  OR e.event_type IN ('client.reply','client.email_in','client.email_out','client.sms_in','client.sms_out','client.call_complete',
   'client.call_logged','client.message_in','supplier.email_in','staff.email_internal','call.transcript_completed','sms_sent','client_replied')
), cand AS MATERIALIZED (
 SELECT e.id, e.job_id, coalesce(e.context_captured_at,e.recorded_at) AS cap,
  coalesce(public.context_scorecard_lane_of(e.event_type,e.source,e.channel,e.direction,e.body_preview,e.metadata),'(no lane)') AS lane,
  e.metadata->'party_roles' AS old_pr, public.context_message_party_roles(e) AS new_pr, e.metadata ? 'party_roles_v4_backfill' AS touched
 FROM public.business_events e JOIN msg ON msg.id=e.id
), d AS (
 SELECT c.lane, c.job_id, c.cap, c.touched,
  (c.old_pr->>'sender_role')||' -> '||(c.old_pr->>'recipient_role') AS old_pair, c.old_pr->>'basis' AS old_basis,
  (c.new_pr->>'sender_role')||' -> '||(c.new_pr->>'recipient_role') AS new_pair, c.new_pr->>'basis' AS new_basis,
  -- Joins row 3's customers (party_roles.audience customer, the five message
  -- lanes, the scorecard's 30 days) with no job to be placed on.
  (c.lane IN ('texts','calls','call_transcripts','emails_in','emails_out') AND c.cap>now()-interval '30 days' AND c.job_id IS NULL
   AND c.new_pr->>'audience'='customer' AND c.old_pr->>'audience' IS DISTINCT FROM 'customer') AS row3_no_job,
  EXISTS (SELECT 1 FROM public.jobs j WHERE j.id=c.job_id
   AND j.status::text NOT IN ('cancelled','draft','archived','complete','completed','lost') AND NOT coalesce(j.archived,false)) AS live_job
 FROM cand c
 WHERE c.new_pr IS NOT NULL
  AND (c.old_pr->>'sender_role',c.old_pr->>'recipient_role',c.old_pr->>'counterpart_role',c.old_pr->>'audience')
   IS DISTINCT FROM (c.new_pr->>'sender_role',c.new_pr->>'recipient_role',c.new_pr->>'counterpart_role',c.new_pr->>'audience')
)
SELECT CASE WHEN grouping(d.lane)=1 THEN '(all)' ELSE d.lane END AS lane, d.old_pair, d.old_basis, d.new_pair, d.new_basis,
 count(*) AS rows, CASE WHEN grouping(d.lane)=1 THEN least(count(*),1000) END AS this_batch,
 count(*) FILTER (WHERE d.row3_no_job) AS row3_no_job,
 count(*) FILTER (WHERE d.touched) AS touched_before, count(*) FILTER (WHERE d.job_id IS NOT NULL) AS on_a_job,
 count(*) FILTER (WHERE d.live_job) AS on_a_live_job, min(d.cap)::date AS first_captured, max(d.cap)::date AS last_captured
FROM d
GROUP BY GROUPING SETS ((d.lane,d.old_pair,d.old_basis,d.new_pair,d.new_basis),())
ORDER BY grouping(d.lane) DESC, d.lane COLLATE "C", count(*) DESC, d.old_basis COLLATE "C", d.old_pair COLLATE "C",
 d.new_pair COLLATE "C", d.new_basis COLLATE "C";

-- 2. Row 2 as the scorecard reads it now (stored stamps), for the before.
SELECT * FROM public.context_party_roles_lanes(now(),30);

-- 3. Row 3 (customer messages placed on a job) as the live scorecard reads it
-- now. Until the scorecard leaves customers with no job out of it, every
-- row3_no_job row above lowers it, and PART 2 refuses such a batch unless
-- owner_accepts_row3_drop is set on the owner's yes.
SELECT l->>'value' AS row3_now, l->>'number' AS row3_pct, l->>'status' AS row3_status
FROM jsonb_array_elements(public.context_scorecard(now())->'rows') r
CROSS JOIN LATERAL jsonb_array_elements(r->'lanes') l
WHERE r->>'row'='3' AND l->>'lane'='customer_facing';
ROLLBACK;

-- ============================================================================
-- PART 2. WRITE (dry run). One batch of at most 1000 rows.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1800s';

DO $pre$
BEGIN
 IF coalesce(obj_description(to_regprocedure('public.context_message_party_roles(public.business_events)'),'pg_proc'),'')
   NOT LIKE 'Party roles v4 (20261007060000):%'
  OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.business_events'::regclass
   AND t.tgname='context_party_roles_business_event' AND NOT t.tgisinternal AND t.tgenabled<>'D')
 THEN RAISE EXCEPTION 'party_roles_v4_backfill: migration 20261007060000 is not live (v4 classifier or trigger missing); refusing'; END IF;
END $pre$;

-- The candidates, read without a lock (the slow pass over every message row)
-- and put in write order: 1, the rows our own label or templates decide
-- (they read no other row); 2, every other row but call transcripts; 3, call
-- transcripts (they read their call); newest first within each.
CREATE TEMP TABLE pr4_cand ON COMMIT DROP AS
WITH msg AS MATERIALIZED (
 SELECT e.id FROM public.business_events e
 WHERE coalesce(e.channel,'') IN ('sms','email','call')
  OR e.event_type IN ('client.reply','client.email_in','client.email_out','client.sms_in','client.sms_out','client.call_complete',
   'client.call_logged','client.message_in','supplier.email_in','staff.email_internal','call.transcript_completed','sms_sent','client_replied')
), cand AS MATERIALIZED (
 SELECT e.id, e.event_type, coalesce(e.event_at,e.occurred_at) AS at, e.metadata->'party_roles' AS old_pr,
  public.context_message_party_roles(e) AS new_pr
 FROM public.business_events e JOIN msg ON msg.id=e.id
)
SELECT c.id, c.at,
 CASE WHEN c.new_pr->>'basis' IN ('ladder_internal','writer','our_template') THEN 1
  WHEN c.event_type='call.transcript_completed' THEN 3 ELSE 2 END AS phase
FROM cand c
WHERE c.new_pr IS NOT NULL
 AND (c.old_pr->>'sender_role',c.old_pr->>'recipient_role',c.old_pr->>'counterpart_role',c.old_pr->>'audience')
  IS DISTINCT FROM (c.new_pr->>'sender_role',c.new_pr->>'recipient_role',c.new_pr->>'counterpart_role',c.new_pr->>'audience');

-- The batch: the first 1000 candidates in write order that are still
-- candidates when read again, locked (a row a writer re-stamped since is
-- skipped). Everything the checks compare is taken from the locked row.
CREATE TEMP TABLE pr4_batch ON COMMIT DROP AS
SELECT e.id, e.job_id, e.attribution_status, e.attribution_step, e.attribution_confidence, e.match_status, e.match_method,
 e.candidate_job_ids, e.contact_id, e.direction, e.channel, e.event_type, md5(e.payload::text) AS payload_md5, e.metadata AS metadata_before,
 coalesce(public.context_scorecard_lane_of(e.event_type,e.source,e.channel,e.direction,e.body_preview,e.metadata),'(no lane)') AS lane,
 c.phase
FROM public.business_events e JOIN pr4_cand c ON c.id=e.id
-- The live reading, once per row (OFFSET 0 keeps it one call).
CROSS JOIN LATERAL (SELECT public.context_message_party_roles(e) AS r OFFSET 0) x
WHERE (e.metadata->'party_roles'->>'sender_role',e.metadata->'party_roles'->>'recipient_role',
       e.metadata->'party_roles'->>'counterpart_role',e.metadata->'party_roles'->>'audience')
  IS DISTINCT FROM (x.r->>'sender_role',x.r->>'recipient_role',x.r->>'counterpart_role',x.r->>'audience')
ORDER BY c.phase, c.at DESC NULLS LAST, e.id
LIMIT 1000
FOR UPDATE OF e;

DO $count$
DECLARE
 -- The this_batch figure PART 1 printed (1000 for the first batch of 7 Oct
 -- 2026's 1,706 emulated lane rows plus the rows outside the lanes). The
 -- write refuses on any other count.
 expected_rows constant integer := 1000;
 n integer;
BEGIN
 SELECT count(*) INTO n FROM pr4_batch;
 IF n <> expected_rows THEN
  RAISE EXCEPTION 'party_roles_v4_backfill: the batch is % rows, expected %; re-run PART 1 and copy this_batch',n,expected_rows;
 END IF;
END $count$;

-- Row 3 (customer messages placed on a job) as the live scorecard reads it
-- before the write, at this transaction's own time (now() is when it began,
-- so a row captured after that is in neither read).
CREATE TEMP TABLE pr4_row3 ON COMMIT DROP AS
SELECT 'before'::text AS at, (SELECT l FROM jsonb_array_elements(public.context_scorecard(now())->'rows') r
  CROSS JOIN LATERAL jsonb_array_elements(r->'lanes') l
  WHERE r->>'row'='3' AND l->>'lane'='customer_facing' LIMIT 1) AS lane;

-- The write, in write order (a later statement sees an earlier one's
-- stamps). A row an earlier batch touched keeps the first stamp it saved.
UPDATE public.business_events e
SET metadata=e.metadata||jsonb_build_object('party_roles_v4_backfill','context_party_roles_v4_backfill_20261007')
 ||CASE WHEN e.metadata ? 'party_roles_prior_v4' THEN '{}'::jsonb ELSE jsonb_build_object('party_roles_prior_v4',e.metadata->'party_roles') END
FROM pr4_batch b WHERE e.id=b.id AND b.phase=1;
UPDATE public.business_events e
SET metadata=e.metadata||jsonb_build_object('party_roles_v4_backfill','context_party_roles_v4_backfill_20261007')
 ||CASE WHEN e.metadata ? 'party_roles_prior_v4' THEN '{}'::jsonb ELSE jsonb_build_object('party_roles_prior_v4',e.metadata->'party_roles') END
FROM pr4_batch b WHERE e.id=b.id AND b.phase=2;
UPDATE public.business_events e
SET metadata=e.metadata||jsonb_build_object('party_roles_v4_backfill','context_party_roles_v4_backfill_20261007')
 ||CASE WHEN e.metadata ? 'party_roles_prior_v4' THEN '{}'::jsonb ELSE jsonb_build_object('party_roles_prior_v4',e.metadata->'party_roles') END
FROM pr4_batch b WHERE e.id=b.id AND b.phase=3;
-- A batch row whose reading moved after its own write (it reads a row this
-- batch wrote later in the same statement, or a writer's commit) is written
-- once more, the same metadata, so the trigger stamps it again.
UPDATE public.business_events e SET metadata=e.metadata
FROM pr4_batch b WHERE e.id=b.id AND e.metadata->'party_roles' IS DISTINCT FROM public.context_message_party_roles(e);

DO $check$
DECLARE n integer; moved integer; bad integer; want integer:=(SELECT count(*) FROM pr4_batch);
BEGIN
 -- Every row came out stamped by the live classifier, its first stamp saved.
 SELECT count(*) INTO n FROM public.business_events e JOIN pr4_batch b ON b.id=e.id
 WHERE e.metadata->>'party_roles_v4_backfill'='context_party_roles_v4_backfill_20261007'
  AND e.metadata->'party_roles_prior_v4' IS NOT DISTINCT FROM
   CASE WHEN b.metadata_before ? 'party_roles_prior_v4' THEN b.metadata_before->'party_roles_prior_v4'
    ELSE coalesce(b.metadata_before->'party_roles','null'::jsonb) END
  AND e.metadata->'party_roles'->>'version'='party_roles_v4'
  AND e.metadata->'party_roles'=public.context_message_party_roles(e);
 IF n<>want THEN RAISE EXCEPTION 'party_roles_v4_backfill: % of % rows came out stamped by the live classifier with the first stamp saved; refusing',n,want; END IF;
 -- Nothing but party_roles and the two backfill keys moved.
 SELECT count(*) INTO moved FROM public.business_events e JOIN pr4_batch b ON b.id=e.id
 WHERE e.job_id IS DISTINCT FROM b.job_id OR e.attribution_status IS DISTINCT FROM b.attribution_status
  OR e.attribution_step IS DISTINCT FROM b.attribution_step OR e.attribution_confidence IS DISTINCT FROM b.attribution_confidence
  OR e.match_status IS DISTINCT FROM b.match_status OR e.match_method IS DISTINCT FROM b.match_method
  OR e.candidate_job_ids IS DISTINCT FROM b.candidate_job_ids OR e.contact_id IS DISTINCT FROM b.contact_id
  OR e.direction IS DISTINCT FROM b.direction OR e.channel IS DISTINCT FROM b.channel OR e.event_type IS DISTINCT FROM b.event_type
  OR md5(e.payload::text) IS DISTINCT FROM b.payload_md5
  OR (e.metadata-'party_roles'-'party_roles_prior_v4'-'party_roles_v4_backfill')
   IS DISTINCT FROM (b.metadata_before-'party_roles'-'party_roles_prior_v4'-'party_roles_v4_backfill');
 IF moved<>0 THEN RAISE EXCEPTION 'party_roles_v4_backfill: % rows changed beyond party_roles; refusing',moved; END IF;
 -- The ladder's labels are never overridden.
 SELECT count(*) INTO bad FROM public.business_events e JOIN pr4_batch b ON b.id=e.id
 WHERE nullif(e.metadata->>'audience','') IS NOT NULL AND e.metadata->'party_roles'->>'audience' IS DISTINCT FROM e.metadata->>'audience';
 IF bad<>0 THEN RAISE EXCEPTION 'party_roles_v4_backfill: % rows disagree with the ladder''s audience; refusing',bad; END IF;
END $check$;

-- The batch's before -> after (what this run stamped), by lane.
SELECT b.lane, b.phase, (b.metadata_before->'party_roles'->>'sender_role')||' -> '||(b.metadata_before->'party_roles'->>'recipient_role') AS old_pair,
 b.metadata_before->'party_roles'->>'basis' AS old_basis,
 (e.metadata->'party_roles'->>'sender_role')||' -> '||(e.metadata->'party_roles'->>'recipient_role') AS new_pair,
 e.metadata->'party_roles'->>'basis' AS new_basis, count(*) AS rows
FROM public.business_events e JOIN pr4_batch b ON b.id=e.id
GROUP BY 1,2,3,4,5,6 ORDER BY b.lane COLLATE "C", b.phase, count(*) DESC, (b.metadata_before->'party_roles'->>'basis') COLLATE "C",
 ((b.metadata_before->'party_roles'->>'sender_role')||' -> '||(b.metadata_before->'party_roles'->>'recipient_role')) COLLATE "C",
 ((e.metadata->'party_roles'->>'sender_role')||' -> '||(e.metadata->'party_roles'->>'recipient_role')) COLLATE "C",
 (e.metadata->'party_roles'->>'basis') COLLATE "C";

-- Row 3 after the write, as the live scorecard reads it in this transaction.
INSERT INTO pr4_row3
SELECT 'after', (SELECT l FROM jsonb_array_elements(public.context_scorecard(now())->'rows') r
  CROSS JOIN LATERAL jsonb_array_elements(r->'lanes') l
  WHERE r->>'row'='3' AND l->>'lane'='customer_facing' LIMIT 1);
SELECT (SELECT lane->>'value' FROM pr4_row3 WHERE at='before') AS row3_before,
 (SELECT lane->>'value' FROM pr4_row3 WHERE at='after') AS row3_after;

DO $row3$
DECLARE
 -- Row 3 counts party_roles.audience customer messages and how many sit on a
 -- job. A prospect has no job to be placed on, so until the scorecard leaves
 -- customers with no job out of row 3 (scorecard v2: no_job_customers -
 -- no_job_customers_on_a_job, context_party_roles_lanes), every prospect this
 -- batch names lowers row 3 (7 Oct 2026, the whole re-stamp: 76.4% to
 -- 71.6%). Set to true only on the owner's yes to that drop; otherwise run
 -- this re-stamp together with or after that scorecard change.
 owner_accepts_row3_drop constant boolean := false;
 b jsonb; a jsonb; bm text[]; am text[]; lowered boolean;
BEGIN
 SELECT lane INTO b FROM pr4_row3 WHERE at='before';
 SELECT lane INTO a FROM pr4_row3 WHERE at='after';
 IF b IS NULL OR a IS NULL THEN
  IF NOT owner_accepts_row3_drop THEN
   RAISE EXCEPTION 'party_roles_v4_backfill: the live scorecard has no row 3 customer_facing lane to compare; refusing (read row 3 by hand; set owner_accepts_row3_drop only on the owner''s yes)';
  END IF;
  RETURN;
 END IF;
 -- Exact counts ("<on a job> of <customer messages> ..."), else the share.
 bm:=regexp_match(coalesce(b->>'value',''),'^(\d+) of (\d+) ');
 am:=regexp_match(coalesce(a->>'value',''),'^(\d+) of (\d+) ');
 lowered:=CASE WHEN bm IS NOT NULL AND am IS NOT NULL
  THEN am[1]::numeric*bm[2]::numeric < bm[1]::numeric*am[2]::numeric
  ELSE coalesce((a->>'number')::numeric,0) < coalesce((b->>'number')::numeric,0) END;
 IF lowered AND NOT owner_accepts_row3_drop THEN
  RAISE EXCEPTION 'party_roles_v4_backfill: this batch lowers row 3 (customer messages placed on a job) from "%" to "%"; the live scorecard counts a customer with no job yet against placement: run the re-stamp together with or after the scorecard change that leaves them out, or set owner_accepts_row3_drop on the owner''s yes; refusing',
   b->>'value',a->>'value';
 END IF;
END $row3$;
ROLLBACK;
