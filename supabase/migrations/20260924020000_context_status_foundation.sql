-- F1: context foundation (INTEGRATION.md Wave 1, slice F1).
--
-- Lays the shared pieces the placement, cadence, sms, dossier and sites slices
-- build on, so none of them has to edit another's objects:
--   1. three new attribution statuses (content_ref, party, unplaced). Nothing in
--      this migration writes them; the placement slices do.
--   2. business_events.candidate_job_ids uuid[] with a GIN index. Written later
--      by the placement track when a row goes to review.
--   3. context_linked_status(text): the one definition of "linked". The Luna
--      custody writer and the current-facts view call it instead of repeating
--      the five-status list, so a content_ref or party row passes custody and
--      its facts stay visible.
--   4. context_unplaced_for_job(uuid): the one "not yet placed, could be this
--      job" read, shared by the dossier's last contact and cadence freshness.
--   5. context_source_freshness(): last capture per business_events.source and
--      the capture_quiet alarm.
--   6. context_pipeline_status() becomes a composer over one sub-function per
--      owner. context_core_status() is today's body, unchanged, and its keys
--      stay top-level so every existing reader sees identical values. The
--      cadence, GHL capture, booking capture and parties blocks are stubs that
--      return null until their owning slice replaces them.
--   7. context_capture_runs, written only through record_capture_run().
--
--   8. Heartbeat cost. The live heartbeat hit the API statement timeout
--      (57014). Per-row helpers inline, the facts view stops serialising event
--      rows, and xero_invoices gets expression statistics for coverage. Every
--      existing output stays identical.
--
-- No flag or switch changes. No row is written or rewritten.
--
-- Built on the LIVE production definitions, read from production 23 Sep 2026
-- (read-only). Every object this migration replaces was compared with the
-- repository body it starts from; all are byte-identical, so no live change is
-- lost:
--   context_pipeline_status()                    md5(prosrc) 0fa6842cebf236e47b608a520c6c9fd1
--     = the 20260917210000 body. Moved unchanged into context_core_status().
--   persist_luna_context_revision(uuid,uuid,uuid,jsonb,jsonb,jsonb,jsonb,text,integer)
--                                                md5(prosrc) d3441ee4b6c93777564f1385b00c73dc
--     = the 20260921140000 body. Replaced by that full signature; the only
--     change is the one linked-status predicate.
--   persist_luna_context_revision(text,text,jsonb,text,jsonb)
--                                                md5(prosrc) f8c4bd29bba0878396ee7626c21ee65d
--     = the 20260910112833 body. Not touched.
--   business_events_attribution_status_check: the nine live values
--     direct, thread, single_open, single_line, luna, admin_bucket, pending_luna,
--     empty, automated. All nine are kept; three are added.
--   current_job_context_facts                    md5(pg_get_viewdef) 4430e6fe155e0bbb8f95c110df417c7c
--     (PostgreSQL 17) = the 20260917120000 view. The linked-status predicate
--     changes, and the retraction test reads b.metadata instead of to_jsonb(b)
--     (same result, see 3b); column order is unchanged.
-- The ledger held nothing at or after 20260923230000 other than that migration.
-- The guard below refuses unless each object is still that pre-image (or
-- already this migration's result, for a re-apply), and unless every new
-- function name is absent or already this migration's body. Anything else is
-- a live change nobody read, and replacing it would silently revert it.
-- Rollback: supabase/rollbacks/20260924020000_context_status_foundation_down.sql
-- restores the live bodies byte for byte and checks their md5 afterwards.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record; view_md5 text; old_path text:=current_setting('search_path');
BEGIN
 FOR x IN SELECT * FROM (VALUES
  -- Replaced objects: live pre-image, or this migration's body.
  ('public.context_pipeline_status()',ARRAY['0fa6842cebf236e47b608a520c6c9fd1','6f78816a6f676cd9a28f6271d2c6c8e0'],false),
  ('public.persist_luna_context_revision(uuid,uuid,uuid,jsonb,jsonb,jsonb,jsonb,text,integer)',
   ARRAY['d3441ee4b6c93777564f1385b00c73dc','2ef95a949f0aae99cc323abde10f2ee7'],false),
  -- New functions: absent, or already this migration's body.
  ('public.context_linked_status(text)',ARRAY['ab0b67927684168cfe94de9118a87a7c'],true),
  ('public.context_unplaced_for_job(uuid)',ARRAY['f2382688c5ae085bd0a7f88a11053c12'],true),
  ('public.context_source_freshness_policy()',ARRAY['230c0b1965208474fc6ea076e5dd3f6f'],true),
  ('public.context_in_business_hours(timestamptz)',ARRAY['70164e9d1d6aa636c4e9d54357396f16'],true),
  ('public.context_business_minutes(timestamptz,timestamptz)',ARRAY['510dbec36291c25aa1887ade89e2ca4e'],true),
  ('public.context_source_freshness()',ARRAY['ce094feb8df8b7dd596e639ac47a7825'],true),
  ('public.context_core_status()',ARRAY['0fa6842cebf236e47b608a520c6c9fd1'],true),
  ('public.context_cadence_status()',ARRAY['155104bfb08b8b3c2f98bdec089d4ee4'],true),
  ('public.context_ghl_capture_status()',ARRAY['155104bfb08b8b3c2f98bdec089d4ee4'],true),
  ('public.context_booking_capture_status()',ARRAY['155104bfb08b8b3c2f98bdec089d4ee4'],true),
  ('public.context_parties_status()',ARRAY['155104bfb08b8b3c2f98bdec089d4ee4'],true),
  ('public.record_capture_run(jsonb)',ARRAY['a85b48f9422fff111ee96093bad55c40'],true)
 ) AS t(sig,accepted,may_be_absent) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL AND x.may_be_absent THEN CONTINUE; END IF;
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 live:=NULL;
 SELECT pg_get_constraintdef(c.oid) INTO live FROM pg_constraint c
 WHERE c.conrelid='public.business_events'::regclass AND c.conname='business_events_attribution_status_check';
 IF live IS NULL OR live NOT IN (
  'CHECK ((attribution_status = ANY (ARRAY[''direct''::text, ''thread''::text, ''single_open''::text, ''single_line''::text, ''luna''::text, ''admin_bucket''::text, ''pending_luna''::text, ''empty''::text, ''automated''::text])))',
  'CHECK ((attribution_status = ANY (ARRAY[''direct''::text, ''thread''::text, ''single_open''::text, ''single_line''::text, ''luna''::text, ''admin_bucket''::text, ''pending_luna''::text, ''empty''::text, ''automated''::text, ''content_ref''::text, ''party''::text, ''unplaced''::text])))')
 THEN problems:=problems||format('business_events_attribution_status_check is %s',coalesce(live,'<missing>')); END IF;
 -- The view text as PostgreSQL prints it, with public on the search path:
 -- the live view (4430e6fe...), or this migration's view (7986bb5a...).
 PERFORM set_config('search_path','public',true);
 SELECT md5(pg_get_viewdef(to_regclass('public.current_job_context_facts'))) INTO view_md5;
 PERFORM set_config('search_path',old_path,true);
 IF view_md5 IS NULL OR view_md5 NOT IN ('4430e6fe155e0bbb8f95c110df417c7c','7986bb5a25495b50c0fed4ce497724a2')
 THEN problems:=problems||format('current_job_context_facts viewdef md5 %s',coalesce(view_md5,'<missing>')); END IF;
 IF EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.business_events'::regclass AND a.attname IN ('retracted_at','retracted')
   AND a.attnum>0 AND NOT a.attisdropped)
 THEN problems:=problems||'business_events has a retracted_at or retracted column; the current-facts view reads only metadata for retraction'::text; END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_status_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. Statuses. A wider check cannot fail on existing rows.
ALTER TABLE public.business_events DROP CONSTRAINT IF EXISTS business_events_attribution_status_check;
ALTER TABLE public.business_events ADD CONSTRAINT business_events_attribution_status_check
 CHECK (attribution_status IN ('direct','thread','single_open','single_line','luna','admin_bucket','pending_luna','empty','automated',
  'content_ref','party','unplaced'));

-- 2. Stored candidate list for rows sent to review. Null until the placement
-- track writes it. Partial GIN: most rows never go to review.
ALTER TABLE public.business_events ADD COLUMN IF NOT EXISTS candidate_job_ids uuid[];
COMMENT ON COLUMN public.business_events.candidate_job_ids IS
 'Jobs this row could belong to, stored when the ladder sends it to review (pending_luna) and kept when Luna leaves it unplaced. Written only by the placement track. Read by context_unplaced_for_job.';
CREATE INDEX IF NOT EXISTS business_events_candidate_job_ids
 ON public.business_events USING gin (candidate_job_ids) WHERE candidate_job_ids IS NOT NULL;
-- Supports the admin-bucket arm of context_unplaced_for_job.
CREATE INDEX IF NOT EXISTS business_events_admin_bucket_contact
 ON public.business_events (contact_id) WHERE attribution_status='admin_bucket' AND contact_id IS NOT NULL;

-- 3. The one definition of a linked row. Never null: an unknown or null status
-- is not linked.
-- No SET clause, so PostgreSQL inlines it into the custody view and writer
-- (a SET clause forces a real call per row, several times slower). Every
-- operator and type is schema-qualified instead, so the caller's search_path
-- cannot change its meaning. SECURITY INVOKER; reads no table.
CREATE OR REPLACE FUNCTION public.context_linked_status(p_status text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT coalesce(p_status OPERATOR(pg_catalog.=) ANY (ARRAY['direct','thread','single_open','single_line','luna','content_ref','party']::pg_catalog.text[]),false)
$$;
COMMENT ON FUNCTION public.context_linked_status(text) IS
 'True for direct, thread, single_open, single_line, luna, content_ref, party. False for pending_luna, unplaced, admin_bucket, empty, automated, null and anything else. The one definition of a row that belongs to its job.';

-- 4. Rows that are not on the job but could be: under review or unplaced with
-- the job in their stored candidates; the job contact's admin-bucket rows; the
-- job contact's worded rows parked on a holding job (metadata.do_not_schedule).
-- The three arms are disjoint by status, so no row appears twice. A job with
-- no GHL contact gets only the first arm.
CREATE OR REPLACE FUNCTION public.context_unplaced_for_job(p_job_id uuid) RETURNS SETOF public.business_events
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH job AS (SELECT j.id, nullif(btrim(j.ghl_contact_id),'') AS contact FROM public.jobs j WHERE j.id=p_job_id),
 rows_out AS (
  SELECT e.* FROM public.business_events e
  WHERE p_job_id IS NOT NULL AND e.attribution_status IN ('pending_luna','unplaced')
   AND e.candidate_job_ids @> ARRAY[p_job_id]
  UNION ALL
  SELECT e.* FROM public.business_events e JOIN job ON e.contact_id=job.contact
  WHERE e.attribution_status='admin_bucket' AND e.contact_id IS NOT NULL
  UNION ALL
  SELECT e.* FROM public.jobs h JOIN public.business_events e ON e.job_id=h.id JOIN job ON e.contact_id=job.contact
  WHERE h.id<>job.id AND coalesce(h.metadata->>'do_not_schedule','') IN ('true','1')
   AND e.attribution_status NOT IN ('pending_luna','unplaced','admin_bucket','empty','automated')
 )
 SELECT * FROM rows_out ORDER BY coalesce(event_at,occurred_at) DESC NULLS LAST, id DESC
$$;
COMMENT ON FUNCTION public.context_unplaced_for_job(uuid) IS
 'Customer rows not placed on this job that could be this job: pending_luna or unplaced rows whose candidate_job_ids contain it, the job contact''s admin_bucket rows, and the job contact''s worded rows sitting on a do_not_schedule holding job. Newest first. Shared by the dossier last contact and cadence freshness.';

-- 5. Capture freshness per writer source.
-- Business hours are Mon to Sat, 07:00 to 18:00 Perth (no public holidays).
CREATE OR REPLACE FUNCTION public.context_source_freshness_policy() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
  'timezone','Australia/Perth','business_days','Mon-Sat','business_hours','07:00-18:00',
  -- capture_quiet fires after this many business minutes without a row.
  'quiet_business_minutes',120,
  -- A source is normally active when, over the rate window ending at its last
  -- row, it wrote at least this many rows per business hour. At 2.5 an honest
  -- source goes 2 business hours without a row about 0.7% of the time.
  'normally_active_min_rows_per_business_hour',2.5,
  'rate_window_days',14,
  -- Sources whose last row is older than this are not listed.
  'lookback_days',60,
  -- business_events.metadata.capture_mode values that are not new capture.
  'ignored_capture_modes',jsonb_build_array('backfill','relink'))
$$;

-- Inlinable like context_linked_status: no SET clause, everything
-- schema-qualified. Called once per captured row by context_source_freshness.
CREATE OR REPLACE FUNCTION public.context_in_business_hours(p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
 SELECT p_at IS NOT NULL
  AND pg_catalog.date_part('isodow',pg_catalog.timezone('Australia/Perth',p_at)) OPERATOR(pg_catalog.>=) 1
  AND pg_catalog.date_part('isodow',pg_catalog.timezone('Australia/Perth',p_at)) OPERATOR(pg_catalog.<=) 6
  AND pg_catalog.timezone('Australia/Perth',p_at)::pg_catalog.time OPERATOR(pg_catalog.>=) '07:00'::pg_catalog.time
  AND pg_catalog.timezone('Australia/Perth',p_at)::pg_catalog.time OPERATOR(pg_catalog.<) '18:00'::pg_catalog.time
$$;

-- Business minutes in [p_from, p_to). Spans longer than 120 days count only the
-- last 120 days, which is far past every threshold that reads it.
CREATE OR REPLACE FUNCTION public.context_business_minutes(p_from timestamptz,p_to timestamptz) RETURNS integer
LANGUAGE sql STABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
 WITH span AS (SELECT greatest(p_from,p_to-interval '120 days') AS f, p_to AS t WHERE p_from IS NOT NULL AND p_to IS NOT NULL AND p_to>p_from),
 days AS (
  SELECT ((g.d::date)::timestamp + time '07:00') AT TIME ZONE 'Australia/Perth' AS day_start,
         ((g.d::date)::timestamp + time '18:00') AT TIME ZONE 'Australia/Perth' AS day_end, span.f, span.t
  FROM span, generate_series((span.f AT TIME ZONE 'Australia/Perth')::date::timestamp,(span.t AT TIME ZONE 'Australia/Perth')::date::timestamp,interval '1 day') AS g(d)
  WHERE extract(isodow FROM g.d) BETWEEN 1 AND 6
 )
 SELECT coalesce(floor(sum(greatest(0,extract(epoch FROM (least(t,day_end)-greatest(f,day_start)))/60)))::integer,0) FROM days
$$;

CREATE OR REPLACE FUNCTION public.context_source_freshness() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 policy jsonb:=public.context_source_freshness_policy();
 quiet_minutes integer:=(policy->>'quiet_business_minutes')::integer;
 min_rate numeric:=(policy->>'normally_active_min_rows_per_business_hour')::numeric;
 rate_window interval:=make_interval(days=>(policy->>'rate_window_days')::integer);
 lookback interval:=make_interval(days=>(policy->>'lookback_days')::integer);
 now_time timestamptz:=now(); sources jsonb; alarms jsonb;
BEGIN
 WITH captured AS (
  SELECT coalesce(nullif(btrim(e.source),''),'(none)') AS source, e.context_captured_at AS at
  FROM public.business_events e
  WHERE e.context_captured_at > now_time-lookback-rate_window AND e.context_captured_at<=now_time
   AND coalesce(e.metadata->>'capture_mode','live') NOT IN (SELECT jsonb_array_elements_text(policy->'ignored_capture_modes'))
 ), latest AS (
  SELECT c.source, max(c.at) AS last_at FROM captured c GROUP BY c.source HAVING max(c.at)>now_time-lookback
 ), measured AS (
  SELECT l.source, l.last_at,
   count(*) FILTER (WHERE c.at>l.last_at-rate_window AND public.context_in_business_hours(c.at)) AS rows_in_business_hours,
   public.context_business_minutes(l.last_at-rate_window,l.last_at) AS window_business_minutes,
   public.context_business_minutes(l.last_at,now_time) AS quiet_business_minutes
  FROM latest l JOIN captured c ON c.source=l.source GROUP BY l.source,l.last_at
 ), judged AS (
  SELECT m.*,
   CASE WHEN m.window_business_minutes>0 THEN round(m.rows_in_business_hours/(m.window_business_minutes/60.0),2) END AS rows_per_business_hour
  FROM measured m
 ), flagged AS (
  SELECT j.*, coalesce(j.rows_per_business_hour>=min_rate,false) AS normally_active,
   coalesce(j.rows_per_business_hour>=min_rate,false) AND j.quiet_business_minutes>=quiet_minutes AS quiet
  FROM judged j
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('source',f.source,'last_captured_at',f.last_at,
   'quiet_business_minutes',f.quiet_business_minutes,'rows_in_business_hours',f.rows_in_business_hours,
   'rate_window_business_minutes',f.window_business_minutes,'rows_per_business_hour',f.rows_per_business_hour,
   'normally_active',f.normally_active,'quiet',f.quiet) ORDER BY f.source),'[]'::jsonb),
  coalesce(jsonb_agg(jsonb_build_object('key','capture_quiet','severity','warning','since',f.last_at,'source',f.source,
   'quiet_business_minutes',f.quiet_business_minutes,'rows_per_business_hour',f.rows_per_business_hour,
   'what_to_do','Evidence from this source has stopped arriving. Check that its writer (function, cron job or webhook) is running, that its provider credentials are valid, and that the capture lane is on.')
   ORDER BY f.source) FILTER (WHERE f.quiet),'[]'::jsonb)
 INTO sources, alarms FROM flagged f;
 RETURN jsonb_build_object('as_of',now_time,'policy',policy,'in_business_hours',public.context_in_business_hours(now_time),
  'capture_lane',public.automation_lane_enabled('capture'),'sources',sources,'alarms',alarms);
END $$;
COMMENT ON FUNCTION public.context_source_freshness() IS
 'Status block capture_sources: last context_captured_at per business_events.source, business minutes since, and the capture_quiet alarm for a normally active source that wrote nothing for 2 business hours. Owned by F1.';

-- 3b. Luna custody: the writer and the current-facts view use context_linked_status
-- instead of their own five-status lists. Both bodies are the 20260921140000 and
-- 20260917120000 definitions with that predicate changed; the writer and the
-- view must agree or persisted facts would be hidden.
-- The view has one more change, for speed: its retraction test on each cited
-- event read to_jsonb(b) four times, serialising the whole row (payload
-- included) per cited event, which was most of the heartbeat's cost. It now
-- reads b.metadata directly. The two top-level keys it also tested
-- (retracted_at, retracted) exist only if business_events has columns of those
-- names; it has none, and the guard above refuses if either ever appears, so
-- the result is identical.
CREATE OR REPLACE FUNCTION public.persist_luna_context_revision(
 p_run_id uuid,p_lease_token uuid,p_job_id uuid,p_events jsonb,p_new jsonb,p_supersedes jsonb,p_retracts jsonb,
 p_extractor_version text DEFAULT 'luna_v2',p_tokens_in integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 r public.context_extraction_runs; ev jsonb; actual jsonb; f jsonb; transition jsonb; previous jsonb;
 event_ids uuid[]:='{}'; refs uuid[]; new_ids uuid[]:='{}'; transition_ids uuid[]:='{}';
 target text; kind text; fact_id uuid; ref uuid; old_id uuid; new_index integer; link uuid;
 event_time timestamptz; confidence numeric; due date; expiry timestamptz; review_time timestamptz;
 source_text text; source_refs jsonb; source_event jsonb; supported_date date; supported_dates date[]; excerpt text; digest text; request_hash text; receipt public.luna_context_job_revisions;
 result jsonb; n integer:=0; ns integer:=0; nr integer:=0; mode text; now_time timestamptz:=clock_timestamp();
BEGIN
 IF p_run_id IS NULL OR p_lease_token IS NULL OR p_job_id IS NULL OR p_extractor_version IS DISTINCT FROM 'luna_v2'
 OR jsonb_typeof(p_events) IS DISTINCT FROM 'array' OR jsonb_array_length(p_events) NOT BETWEEN 1 AND 25
 OR jsonb_typeof(p_new) IS DISTINCT FROM 'array' OR jsonb_typeof(p_supersedes) IS DISTINCT FROM 'array'
 OR jsonb_typeof(p_retracts) IS DISTINCT FROM 'array' OR p_tokens_in IS NULL OR p_tokens_in<0
 THEN RAISE EXCEPTION 'luna_job_revision_invalid'; END IF;
 request_hash:=encode(sha256(convert_to(jsonb_build_object('job',p_job_id,'events',p_events,'new',p_new,
   'supersedes',p_supersedes,'retracts',p_retracts,'version',p_extractor_version)::text,'UTF8')),'hex');
 -- Serialize the whole revision and its receipt before examining source rows.
 SELECT run.* INTO r FROM public.context_extraction_runs run WHERE run.id=p_run_id FOR UPDATE;
 IF NOT FOUND OR r.job_id IS DISTINCT FROM p_job_id OR r.phase<>'extraction' THEN RAISE EXCEPTION 'luna_run_identity_invalid'; END IF;
 SELECT rev.* INTO receipt FROM public.luna_context_job_revisions rev WHERE rev.run_id=p_run_id;
 IF FOUND THEN
  IF receipt.request_sha256=request_hash THEN RETURN receipt.result||jsonb_build_object('outcome','idempotent'); END IF;
  RETURN jsonb_build_object('outcome','held','reason','run_already_committed');
 END IF;
 IF r.status<>'running' OR r.lease_token IS DISTINCT FROM p_lease_token OR r.lease_expires_at<=now_time OR r.lease_expires_at IS NULL
  OR NOT public.automation_lane_enabled('extraction') THEN RETURN jsonb_build_object('outcome','held','reason','lease_or_lane'); END IF;
 -- All expected source bytes are checked under row locks. Sort locks to avoid
 -- inter-job source swaps creating inconsistent lock order.
 FOR ev IN SELECT value FROM jsonb_array_elements(p_events) ORDER BY value->>'id' LOOP
  IF jsonb_typeof(ev) IS DISTINCT FROM 'object' OR ev->>'id' IS NULL THEN RAISE EXCEPTION 'luna_source_identity_invalid'; END IF;
  ref:=(ev->>'id')::uuid;
  IF ref=ANY(event_ids) THEN RAISE EXCEPTION 'luna_duplicate_source'; END IF;
  SELECT to_jsonb(b) INTO actual FROM public.business_events b WHERE b.id=ref FOR UPDATE;
  IF actual IS NULL OR actual IS DISTINCT FROM ev THEN RAISE EXCEPTION 'luna_source_revision_stale'; END IF;
  IF actual->>'job_id' IS DISTINCT FROM p_job_id::text OR actual->>'attribution_status' IS NULL
   OR NOT public.context_linked_status(actual->>'attribution_status')
   OR (actual#>>'{payload,job_id}' IS NOT NULL AND actual#>>'{payload,job_id}' IS DISTINCT FROM p_job_id::text)
   OR coalesce(actual->>'event_at',actual->>'occurred_at') IS NULL OR actual->>'attribution_confidence' IS NULL
   OR (actual->>'attribution_confidence')::numeric NOT BETWEEN 0 AND 1
   OR actual->>'retracted_at' IS NOT NULL OR actual#>>'{metadata,retracted_at}' IS NOT NULL
   OR actual->>'retracted'='true' OR actual#>>'{metadata,retracted}'='true'
  THEN RAISE EXCEPTION 'luna_source_attribution_rejected'; END IF;
  IF EXISTS(SELECT 1 FROM public.context_extraction_event_receipts e WHERE e.event_id=ref AND e.job_id=p_job_id AND e.extractor_version='luna_v2')
   THEN RETURN jsonb_build_object('outcome','held','reason','source_already_processed'); END IF;
  event_ids:=array_append(event_ids,ref);
 END LOOP;
 -- Validate every transition BEFORE any insert/update. Expected view snapshots
 -- protect concurrent edits; the custody hash additionally protects v2 history.
 FOREACH mode IN ARRAY ARRAY['superseded','retracted'] LOOP
  FOR transition IN SELECT value FROM jsonb_array_elements(CASE WHEN mode='superseded' THEN p_supersedes ELSE p_retracts END) LOOP
   target:=transition->>'fact_store'; old_id:=(transition->>'fact_id')::uuid;
   IF target IS NULL OR target NOT IN ('job_context','job_temporary_context') OR old_id IS NULL
    OR nullif(btrim(transition->>'reason'),'') IS NULL OR jsonb_typeof(transition->'source_event_ids') IS DISTINCT FROM 'array'
    OR jsonb_array_length(transition->'source_event_ids')=0 OR old_id=ANY(transition_ids)
   THEN RAISE EXCEPTION 'luna_transition_invalid'; END IF;
   SELECT array_agg(value::uuid) INTO refs FROM jsonb_array_elements_text(transition->'source_event_ids');
   IF NOT refs <@ event_ids THEN RAISE EXCEPTION 'luna_transition_source_mismatch'; END IF;
   new_index:=(transition->>'new_fact_index')::integer;
   IF new_index IS NOT NULL AND (mode<>'superseded' OR new_index<0 OR new_index>=jsonb_array_length(p_new)) THEN RAISE EXCEPTION 'luna_transition_link_invalid'; END IF;
   EXECUTE format('SELECT to_jsonb(f) FROM public.%I f WHERE id=$1 FOR UPDATE',target) INTO previous USING old_id;
   SELECT c.fact_sha256 INTO digest FROM public.luna_context_fact_custody c WHERE c.fact_store=target AND c.fact_id=old_id;
   SELECT to_jsonb(v) INTO actual FROM public.current_job_context_facts v WHERE v.id=old_id AND v._context_store=target;
   IF previous IS NULL OR previous->>'job_id' IS DISTINCT FROM p_job_id::text OR previous->>'lifecycle' IS DISTINCT FROM 'current'
    OR actual IS NULL OR transition->'expected_fact' IS DISTINCT FROM actual
   THEN RETURN jsonb_build_object('outcome','held','reason','fact_custody_changed'); END IF;
   IF previous->>'extractor_version'='luna_v2' AND previous->>'trust'='luna' THEN
    IF digest IS NULL OR digest IS DISTINCT FROM encode(sha256(convert_to(previous::text,'UTF8')),'hex')
     THEN RETURN jsonb_build_object('outcome','held','reason','fact_custody_changed'); END IF;
   ELSIF coalesce(previous->>'extractor_version',previous#>>'{provenance,extractor}',previous#>>'{provenance,extractor_version}','')
     NOT IN ('context-fact-extractor:v1','context-fact-extractor:v1.5','context-fact-extractor:v2','context-fact-extractor.ts','context-luna-subscription:v1')
     OR coalesce(previous#>>'{provenance,writer_role}','classifier')<>'classifier' THEN
    RETURN jsonb_build_object('outcome','held','reason','human_fact');
   END IF;
   transition_ids:=array_append(transition_ids,old_id);
  END LOOP;
 END LOOP;
 FOR f IN SELECT value FROM jsonb_array_elements(p_new) LOOP
  kind:=f->>'kind';
  IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR kind IS NULL
   OR kind NOT IN ('scope_spec','access_note','alternative_contact','client_preference','note','proposal','current_state','pending_action','quote_issue','job_brief')
   OR nullif(btrim(f->>'text'),'') IS NULL OR (kind='job_brief' AND length(f->>'text')>16000) OR (kind<>'job_brief' AND length(f->>'text')>4000)
   OR jsonb_typeof(f->'confidence') IS DISTINCT FROM 'number' OR (f->>'confidence')::numeric NOT BETWEEN 0 AND 1
   OR jsonb_typeof(f->'source_event_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(f->'source_event_ids')=0
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(f) k WHERE k NOT IN ('kind','text','confidence','source_event_ids','evidence_excerpt','due_date'))
  THEN RAISE EXCEPTION 'luna_fact_shape_invalid'; END IF;
  SELECT array_agg(DISTINCT value::uuid ORDER BY value::uuid) INTO refs FROM jsonb_array_elements_text(f->'source_event_ids');
  IF NOT refs <@ event_ids THEN RAISE EXCEPTION 'luna_fact_source_mismatch'; END IF;
  SELECT max(coalesce((value->>'event_at')::timestamptz,(value->>'occurred_at')::timestamptz)),min((value->>'attribution_confidence')::numeric),
    string_agg(public.context_event_text(jsonb_populate_record(NULL::public.business_events,value)),' ')
   INTO event_time,confidence,source_text FROM jsonb_array_elements(p_events) WHERE (value->>'id')::uuid=ANY(refs);
  IF f->>'due_date' IS NOT NULL AND f->>'due_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION 'luna_due_date_shape_invalid'; END IF;
  due:=(f->>'due_date')::date;
  excerpt:=nullif(f->>'evidence_excerpt','');
  IF excerpt IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_events) cited
   WHERE (cited->>'id')::uuid=ANY(refs) AND position(excerpt in public.context_event_text(jsonb_populate_record(NULL::public.business_events,cited)))>0)
   THEN RAISE EXCEPTION 'luna_excerpt_unsupported'; END IF;
  IF due IS NOT NULL THEN
   IF kind<>'pending_action' THEN RAISE EXCEPTION 'luna_due_date_unsupported'; END IF;
   supported_dates:='{}';
   FOR source_event IN SELECT value FROM jsonb_array_elements(p_events) WHERE (value->>'id')::uuid=ANY(refs) LOOP
    source_text:=public.context_event_text(jsonb_populate_record(NULL::public.business_events,source_event));
    IF excerpt IS NOT NULL THEN
     IF position(excerpt in source_text)=0 THEN CONTINUE; END IF;
     source_text:=excerpt;
    ELSIF cardinality(refs)<>1 THEN RAISE EXCEPTION 'luna_due_date_excerpt_required'; END IF;
    supported_date:=public.context_supported_due_date(source_text,coalesce((source_event->>'event_at')::timestamptz,(source_event->>'occurred_at')::timestamptz));
    IF supported_date IS NULL OR supported_date IS DISTINCT FROM due THEN RAISE EXCEPTION 'luna_due_date_unsupported'; END IF;
    supported_dates:=array_append(supported_dates,supported_date);
   END LOOP;
   IF cardinality(supported_dates)=0 THEN RAISE EXCEPTION 'luna_due_date_unsupported'; END IF;
  END IF;
  expiry:=public.context_fact_expiry(kind,event_time,due);
  review_time:=CASE WHEN kind='client_preference' THEN ((event_time AT TIME ZONE 'Australia/Perth')+interval '1 year') AT TIME ZONE 'Australia/Perth' ELSE NULL END;
  target:=CASE WHEN kind IN ('current_state','pending_action','quote_issue') THEN 'job_temporary_context' ELSE 'job_context' END;
  fact_id:=md5(p_run_id::text||':luna_v2:'||n::text)::uuid;
  SELECT jsonb_agg(jsonb_build_object('table','business_events','id',cited.source_event_id::text) ORDER BY cited.source_event_id) INTO source_refs FROM unnest(refs) AS cited(source_event_id);
  EXECUTE format('INSERT INTO public.%I(id,job_id,kind,value,provenance,correlation_id,lifecycle,event_date,expires_at,review_at,source_event_ids,attribution_confidence,extractor_version,trust)
   VALUES($1,$2,$3,$4,$5,$6,''current'',$7,$8,$9,$10,$11,''luna_v2'',''luna'') RETURNING to_jsonb(%I)',target,target)
  INTO actual USING fact_id,p_job_id,kind,
   jsonb_strip_nulls(jsonb_build_object('text',f->>'text','confidence',(f->>'confidence')::numeric,'source_refs',source_refs,'evidence_excerpt',f->>'evidence_excerpt','due_date',due)),
   jsonb_build_object('extractor','luna_v2','writer_role','classifier','untrusted',false,'lifecycle','active','source_event_ids',to_jsonb(refs),
    'event_at',event_time,'safety',jsonb_build_object('memory_trusted',true,'action_safe',false,'state_change_safe',false,'outbound_safe',false)),
   p_run_id,(event_time AT TIME ZONE 'Australia/Perth')::date,expiry,review_time,refs,confidence;
  INSERT INTO public.luna_context_fact_custody(fact_store,fact_id,fact_sha256,run_id)
   VALUES(target,fact_id,encode(sha256(convert_to(actual::text,'UTF8')),'hex'),p_run_id);
  new_ids:=array_append(new_ids,fact_id);n:=n+1;
 END LOOP;
 FOREACH mode IN ARRAY ARRAY['superseded','retracted'] LOOP
  FOR transition IN SELECT value FROM jsonb_array_elements(CASE WHEN mode='superseded' THEN p_supersedes ELSE p_retracts END) LOOP
   target:=transition->>'fact_store';old_id:=(transition->>'fact_id')::uuid;new_index:=(transition->>'new_fact_index')::integer;
   link:=CASE WHEN new_index IS NULL THEN NULL ELSE new_ids[new_index+1] END;
   EXECUTE format('UPDATE public.%I SET lifecycle=$2,lifecycle_reason=$3,superseded_by=$4,updated_at=$5,
    provenance=provenance||jsonb_build_object(''lifecycle'',$2,''retirement_source_event_ids'',$6,''retirement_run_id'',$7,''safety'',coalesce(provenance->''safety'',''{}''::jsonb)||''{"memory_trusted":false}''::jsonb)
    WHERE id=$1 RETURNING to_jsonb(%I)',target,target) INTO actual USING old_id,mode,transition->>'reason',link,now_time,transition->'source_event_ids',p_run_id;
   UPDATE public.luna_context_fact_custody c SET fact_sha256=encode(sha256(convert_to(actual::text,'UTF8')),'hex'),run_id=p_run_id WHERE c.fact_store=target AND c.fact_id=old_id;
   IF mode='superseded' THEN ns:=ns+1;ELSE nr:=nr+1;END IF;
  END LOOP;
 END LOOP;
 IF NOT public.finish_context_extraction_run(p_run_id,p_lease_token,'done',event_ids,p_tokens_in,n,ns,nr,NULL,NULL)
 THEN RAISE EXCEPTION 'luna_run_lease_lost'; END IF;
 result:=jsonb_build_object('outcome','inserted','facts_new',n,'facts_superseded',ns,'facts_retracted',nr,'fact_ids',to_jsonb(new_ids));
 INSERT INTO public.luna_context_job_revisions(run_id,request_sha256,source_revisions,result)
  SELECT p_run_id,request_hash,jsonb_object_agg(value->>'id',encode(sha256(convert_to(value::text,'UTF8')),'hex')),result FROM jsonb_array_elements(p_events);
 RETURN result;
EXCEPTION WHEN OTHERS THEN
 IF SQLERRM LIKE 'luna\_%' ESCAPE '\' THEN RAISE; END IF;
 RAISE EXCEPTION 'luna_job_revision_failed';
END $$;
REVOKE ALL ON FUNCTION public.persist_luna_context_revision(uuid,uuid,uuid,jsonb,jsonb,jsonb,jsonb,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.persist_luna_context_revision(uuid,uuid,uuid,jsonb,jsonb,jsonb,jsonb,text,integer) TO service_role;

CREATE OR REPLACE VIEW public.current_job_context_facts WITH (security_invoker=true) AS
SELECT visible.* FROM (
 SELECT id,job_id,kind,value,provenance,correlation_id,created_at,updated_at,expires_at,'job_context'::text AS _context_store,
  lifecycle,event_date,source_event_ids,attribution_confidence,extractor_version,superseded_by,lifecycle_reason,trust,review_at
 FROM public.job_context
 UNION ALL
 SELECT id,job_id,kind,value,provenance,correlation_id,created_at,updated_at,expires_at,'job_temporary_context'::text AS _context_store,
  lifecycle,event_date,source_event_ids,attribution_confidence,extractor_version,superseded_by,lifecycle_reason,trust,review_at
 FROM public.job_temporary_context
) visible
WHERE lifecycle='current' AND (expires_at IS NULL OR expires_at>now())
 AND (kind NOT IN ('current_state','pending_action','quote_issue','proposal') OR expires_at IS NOT NULL OR trust IS DISTINCT FROM 'legacy')
 AND (extractor_version IS DISTINCT FROM 'luna_v2' OR (
  cardinality(source_event_ids)>0 AND NOT EXISTS (
   SELECT 1 FROM unnest(visible.source_event_ids) AS cited(source_event_id)
   LEFT JOIN public.business_events b ON b.id=cited.source_event_id
   WHERE b.id IS NULL OR b.job_id IS DISTINCT FROM visible.job_id
    OR b.attribution_status IS NULL OR NOT public.context_linked_status(b.attribution_status)
    OR coalesce(b.event_at,b.occurred_at) IS NULL OR b.attribution_confidence IS NULL OR b.attribution_confidence NOT BETWEEN 0 AND 1
    OR b.metadata->>'retracted_at' IS NOT NULL OR b.metadata->>'retracted'='true'
  )))
 AND provenance#>'{safety,memory_trusted}' IS DISTINCT FROM 'false'::jsonb
 AND coalesce(CASE WHEN jsonb_typeof(provenance->'lifecycle')='object' THEN provenance#>>'{lifecycle,state}' ELSE provenance->>'lifecycle' END,'active') NOT IN ('superseded','retracted')
 AND nullif(provenance->>'superseded_by','') IS NULL AND nullif(provenance->>'retracted_at','') IS NULL
 AND (kind<>'quote_issue' OR NOT EXISTS(SELECT 1 FROM public.jobs j WHERE j.id=visible.job_id
   AND (to_jsonb(j)->>'quoted_at')::timestamptz >= coalesce((visible.provenance->>'event_at')::timestamptz,visible.event_date::timestamp AT TIME ZONE 'Australia/Perth',visible.created_at))
 AND NOT EXISTS(SELECT 1 FROM public.job_events je WHERE je.job_id=visible.job_id AND je.event_type='quote_sent'
   AND je.created_at >= coalesce((visible.provenance->>'event_at')::timestamptz,visible.event_date::timestamp AT TIME ZONE 'Australia/Perth',visible.created_at)));
REVOKE ALL ON public.current_job_context_facts FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.current_job_context_facts TO service_role;

-- 3c. context_coverage() (core block, body unchanged) counts open AUTHORISED
-- ACCREC invoices through upper(coalesce(status,'')) and
-- upper(coalesce(invoice_type,'ACCREC')). Without statistics on those
-- expressions the planner guesses one matching invoice and nests a loop over
-- the whole fact list for each of the three invoice counts. Expression
-- statistics give it the real count so it hashes instead. No data or body
-- change; ANALYZE of this one table is quick.
CREATE STATISTICS IF NOT EXISTS public.xero_invoices_context_open_ar
 ON (upper(coalesce(status,''))), (upper(coalesce(invoice_type,'ACCREC'))) FROM public.xero_invoices;
ANALYZE public.xero_invoices;

-- 6. Status composer. Each owner replaces only its own sub-function with
-- CREATE OR REPLACE, keeping the signature () RETURNS jsonb and returning an
-- object with an "alarms" array (each alarm: key, severity, since, what_to_do).
-- Only F1 ever changes context_pipeline_status() itself.
--
-- 6a. context_core_status(): the 20260917210000 context_pipeline_status() body,
-- moved unchanged.
CREATE OR REPLACE FUNCTION public.context_core_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d date:=(now() AT TIME ZONE 'Australia/Perth')::date; switches jsonb; queue jsonb; calls integer; call_state text:='available'; ready integer;
BEGIN
 SELECT to_jsonb(s) INTO switches FROM public.automation_switches s WHERE id=1;
 SELECT jsonb_object_agg(status,n) INTO queue FROM (SELECT coalesce(e.attribution_status,'unknown') status,count(*) n
 FROM public.business_events e WHERE e.attribution_status NOT IN ('empty','automated')
 AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r WHERE r.event_id=e.id AND r.job_id=e.job_id AND r.extractor_version='luna_v2')
 GROUP BY e.attribution_status) q;
 BEGIN
  EXECUTE 'SELECT count(*) FROM public.context_model_call_reservations WHERE run_date=$1' INTO calls USING d;
 EXCEPTION WHEN OTHERS THEN calls:=NULL;call_state:='unavailable'; END;
 SELECT count(*) INTO ready FROM public.context_extraction_candidates(400);
 RETURN jsonb_build_object('as_of',now(),'run_date',d,'switches',switches,
  'lanes',jsonb_build_object('capture',public.automation_lane_enabled('capture'),'attribution',public.automation_lane_enabled('attribution'),'extraction',public.automation_lane_enabled('extraction')),
  'runs_used',(SELECT count(*) FROM public.context_extraction_runs WHERE run_date=d AND phase='extraction'),'run_cap',400,
  'runs_by_status',(SELECT coalesce(jsonb_object_agg(status,n),'{}'::jsonb) FROM (SELECT status,count(*) n FROM public.context_extraction_runs WHERE run_date=d AND phase='extraction' GROUP BY status) s),
  'failed_by_error',(SELECT coalesce(jsonb_object_agg(coalesce(nullif(error,''),'(none)'),n),'{}'::jsonb) FROM (SELECT error,count(*) n FROM public.context_extraction_runs WHERE run_date=d AND phase='extraction' AND status='failed' GROUP BY error) s),
  'model_calls_used',calls,'model_call_cap',400,'model_call_budget_state',call_state,
  'evidence_by_attribution_status',coalesce(queue,'{}'::jsonb),'ready_jobs',ready,'ready_jobs_is_lower_bound',ready=400,
  'admin_bucket_size',(SELECT count(*) FROM public.business_events WHERE attribution_status='admin_bucket'),
  'missing_event_time',(SELECT count(*) FROM public.business_events WHERE event_at IS NULL AND occurred_at IS NULL AND attribution_status NOT IN ('empty','automated')),
  'oldest_pending_event_at',(SELECT min(coalesce(e.event_at, e.occurred_at)) FROM public.business_events e WHERE e.attribution_status NOT IN ('empty','automated') AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r WHERE r.event_id=e.id AND r.job_id=e.job_id AND r.extractor_version='luna_v2')),
  'last_pass_finished_at',(SELECT max(finished_at) FROM public.context_pass_days WHERE status='done'),
  'today_pass',(SELECT to_jsonb(p) FROM public.context_pass_days p WHERE run_date=d),
  'coverage',public.context_coverage());
END $$;
COMMENT ON FUNCTION public.context_core_status() IS
 'Status block core: the 17 Sep heartbeat body, unchanged. Its keys are the top-level keys of context_pipeline_status(). Owned by F1.';

-- 6b. Stubs for blocks not built yet. Each owning slice replaces its own.
CREATE OR REPLACE FUNCTION public.context_cadence_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT NULL::jsonb $$;
COMMENT ON FUNCTION public.context_cadence_status() IS
 'F1 stub. Status block cadence, owned by cadence slice K1, which replaces this body. Null means not built yet.';
CREATE OR REPLACE FUNCTION public.context_ghl_capture_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT NULL::jsonb $$;
COMMENT ON FUNCTION public.context_ghl_capture_status() IS
 'F1 stub. Status block ghl_capture, owned by sms slice C1d, which replaces this body. Null means not built yet.';
CREATE OR REPLACE FUNCTION public.context_booking_capture_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT NULL::jsonb $$;
COMMENT ON FUNCTION public.context_booking_capture_status() IS
 'F1 stub. Status block booking_capture, owned by dossier slice D3, which replaces this body. Null means not built yet.';
CREATE OR REPLACE FUNCTION public.context_parties_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT NULL::jsonb $$;
COMMENT ON FUNCTION public.context_parties_status() IS
 'F1 stub. Status block parties, owned by sites slice S-M1, which replaces this body. Null means not built yet.';

-- 6c. The composer. Core keys stay top-level and win over any block key, so
-- today's readers see identical values. A block that raises is reported as
-- {"error": SQLSTATE} plus a status_block_failed alarm instead of taking the
-- whole heartbeat down; a core failure still fails the read as it does today.
CREATE OR REPLACE FUNCTION public.context_pipeline_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE core jsonb; blocks jsonb:='{}'::jsonb; alarms jsonb:='[]'::jsonb; b record; v jsonb; a jsonb;
BEGIN
 core:=public.context_core_status();
 FOR b IN SELECT t.block,t.fn FROM (VALUES
   (1,'cadence','context_cadence_status'),
   (2,'capture_sources','context_source_freshness'),
   (3,'ghl_capture','context_ghl_capture_status'),
   (4,'booking_capture','context_booking_capture_status'),
   (5,'parties','context_parties_status')) AS t(ord,block,fn) ORDER BY t.ord LOOP
  BEGIN
   EXECUTE format('SELECT public.%I()',b.fn) INTO v;
  EXCEPTION WHEN OTHERS THEN
   v:=jsonb_build_object('error',SQLSTATE);
   alarms:=alarms||jsonb_build_array(jsonb_build_object('key','status_block_failed','severity','warning','since',now(),
    'block',b.block,'code',SQLSTATE,'what_to_do','This part of the context status could not be read. Check the named status function; the rest of the status is unaffected.'));
  END;
  blocks:=blocks||jsonb_build_object(b.block,v);
  IF jsonb_typeof(v->'alarms')='array' THEN
   FOR a IN SELECT value FROM jsonb_array_elements(v->'alarms') LOOP
    alarms:=alarms||jsonb_build_array(CASE WHEN jsonb_typeof(a)='object' THEN jsonb_build_object('block',b.block)||a
     ELSE jsonb_build_object('block',b.block,'value',a) END);
   END LOOP;
  END IF;
 END LOOP;
 RETURN blocks||jsonb_build_object('alarms',alarms)||core;
END $$;
COMMENT ON FUNCTION public.context_pipeline_status() IS
 'Context pipeline heartbeat composer: context_core_status() keys at top level, plus cadence, capture_sources, ghl_capture, booking_capture, parties blocks (null until built) and alarms[], the concatenation of every block''s alarms. Only F1 changes this function.';

-- 7. Capture run rows for the GHL message reconciler and the booking
-- reconciler. One row per run; a run may be recorded several times while
-- running (cursor and watermark after each page) and once more when it
-- finishes. Written only through record_capture_run(); service_role may read.
CREATE TABLE IF NOT EXISTS public.context_capture_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_]{2,62}$'),
 status text NOT NULL CHECK (status IN ('running','succeeded','partial','failed')),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 window_from timestamptz,
 window_to timestamptz,
 watermark timestamptz,
 cursor jsonb,
 counts jsonb NOT NULL DEFAULT '{}'::jsonb,
 error_code text CHECK (error_code ~ '^[a-z0-9][a-z0-9_.:-]{0,119}$'),
 CONSTRAINT context_capture_runs_finished CHECK ((status='running')=(finished_at IS NULL)),
 CONSTRAINT context_capture_runs_failed_code CHECK (status<>'failed' OR error_code IS NOT NULL),
 CONSTRAINT context_capture_runs_window CHECK (window_from IS NULL OR window_to IS NULL OR window_from<=window_to),
 CONSTRAINT context_capture_runs_counts CHECK (jsonb_typeof(counts)='object'),
 CONSTRAINT context_capture_runs_cursor CHECK (cursor IS NULL OR (jsonb_typeof(cursor) IN ('object','array') AND octet_length(cursor::text)<=4096))
);
CREATE INDEX IF NOT EXISTS context_capture_runs_source_started ON public.context_capture_runs(source,started_at DESC);
CREATE INDEX IF NOT EXISTS context_capture_runs_source_succeeded ON public.context_capture_runs(source,finished_at DESC) WHERE status='succeeded';
ALTER TABLE public.context_capture_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_capture_runs FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.context_capture_runs TO service_role;
COMMENT ON TABLE public.context_capture_runs IS
 'One row per capture reconcile run (source ghl_message_reconcile, scope_booking, ...). Written only through record_capture_run(); service_role has SELECT only. Counts and codes, never message text.';

-- p_run keys: run_id (optional uuid; a new id creates the run, an existing id
-- updates it), source (required), status (default running), window_from,
-- window_to, watermark, cursor, counts (object of non-negative integers,
-- replaced whole), error_code. A key that is absent keeps the stored value.
-- A finished run is immutable: an identical repeat returns unchanged, any
-- other change refuses capture_run_finished.
CREATE OR REPLACE FUNCTION public.record_capture_run(p_run jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 r public.context_capture_runs; n public.context_capture_runs; run_id uuid; src text; k text; val jsonb; existed boolean;
 now_time timestamptz:=clock_timestamp();
BEGIN
 IF p_run IS NULL OR jsonb_typeof(p_run)<>'object'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_run) x WHERE x NOT IN ('run_id','source','status','window_from','window_to','watermark','cursor','counts','error_code'))
 THEN RAISE EXCEPTION 'capture_run_invalid'; END IF;
 src:=nullif(btrim(p_run->>'source'),'');
 IF src IS NULL OR src !~ '^[a-z][a-z0-9_]{2,62}$' THEN RAISE EXCEPTION 'capture_run_source_invalid'; END IF;
 IF p_run ? 'status' AND (p_run->>'status') NOT IN ('running','succeeded','partial','failed') THEN RAISE EXCEPTION 'capture_run_status_invalid'; END IF;
 IF p_run ? 'counts' THEN
  val:=p_run->'counts';
  IF jsonb_typeof(val)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(val))>40 THEN RAISE EXCEPTION 'capture_run_counts_invalid'; END IF;
  FOR k IN SELECT jsonb_object_keys(val) LOOP
   IF k !~ '^[a-z][a-z0-9_]{0,62}$' OR jsonb_typeof(val->k)<>'number' OR (val->>k)::numeric<0 OR (val->>k)::numeric<>trunc((val->>k)::numeric)
    OR (val->>k)::numeric>2147483647
   THEN RAISE EXCEPTION 'capture_run_counts_invalid'; END IF;
  END LOOP;
 END IF;
 BEGIN
  run_id:=coalesce((p_run->>'run_id')::uuid,gen_random_uuid());
  n.window_from:=(p_run->>'window_from')::timestamptz; n.window_to:=(p_run->>'window_to')::timestamptz; n.watermark:=(p_run->>'watermark')::timestamptz;
 EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RAISE EXCEPTION 'capture_run_invalid';
 END;
 SELECT * INTO r FROM public.context_capture_runs c WHERE c.id=run_id FOR UPDATE;
 existed:=FOUND;
 IF existed THEN
  IF r.source<>src THEN RAISE EXCEPTION 'capture_run_source_mismatch'; END IF;
  n:=r;
 ELSE
  n.id:=run_id; n.source:=src; n.status:='running'; n.started_at:=now_time; n.counts:='{}'::jsonb;
  n.window_from:=NULL; n.window_to:=NULL; n.watermark:=NULL; n.cursor:=NULL; n.error_code:=NULL; n.finished_at:=NULL;
 END IF;
 IF p_run ? 'status' THEN n.status:=p_run->>'status'; END IF;
 IF p_run ? 'window_from' THEN n.window_from:=(p_run->>'window_from')::timestamptz; END IF;
 IF p_run ? 'window_to' THEN n.window_to:=(p_run->>'window_to')::timestamptz; END IF;
 IF p_run ? 'watermark' THEN n.watermark:=(p_run->>'watermark')::timestamptz; END IF;
 IF p_run ? 'cursor' THEN n.cursor:=CASE WHEN jsonb_typeof(p_run->'cursor')='null' THEN NULL ELSE p_run->'cursor' END; END IF;
 IF p_run ? 'counts' THEN n.counts:=p_run->'counts'; END IF;
 IF p_run ? 'error_code' THEN n.error_code:=nullif(p_run->>'error_code',''); END IF;
 IF n.error_code IS NOT NULL AND n.error_code !~ '^[a-z0-9][a-z0-9_.:-]{0,119}$' THEN RAISE EXCEPTION 'capture_run_error_code_invalid'; END IF;
 IF n.status='failed' AND n.error_code IS NULL THEN RAISE EXCEPTION 'capture_run_error_code_required'; END IF;
 IF existed AND r.status<>'running' THEN
  IF (n.status,n.window_from,n.window_to,n.watermark,n.cursor,n.counts,n.error_code)
     IS NOT DISTINCT FROM (r.status,r.window_from,r.window_to,r.watermark,r.cursor,r.counts,r.error_code)
  THEN RETURN jsonb_build_object('outcome','unchanged','run_id',r.id,'source',r.source,'status',r.status); END IF;
  RAISE EXCEPTION 'capture_run_finished';
 END IF;
 n.updated_at:=now_time;
 n.finished_at:=CASE WHEN n.status='running' THEN NULL ELSE now_time END;
 BEGIN
  IF existed THEN
   UPDATE public.context_capture_runs c SET status=n.status,updated_at=n.updated_at,finished_at=n.finished_at,window_from=n.window_from,
    window_to=n.window_to,watermark=n.watermark,cursor=n.cursor,counts=n.counts,error_code=n.error_code WHERE c.id=n.id;
  ELSE
   INSERT INTO public.context_capture_runs(id,source,status,started_at,updated_at,finished_at,window_from,window_to,watermark,cursor,counts,error_code)
   VALUES(n.id,n.source,n.status,n.started_at,n.updated_at,n.finished_at,n.window_from,n.window_to,n.watermark,n.cursor,n.counts,n.error_code);
  END IF;
 EXCEPTION WHEN check_violation THEN RAISE EXCEPTION 'capture_run_invalid';
  WHEN unique_violation THEN RAISE EXCEPTION 'capture_run_conflict';
 END;
 RETURN jsonb_build_object('outcome',CASE WHEN existed THEN 'updated' ELSE 'created' END,'run_id',n.id,'source',n.source,'status',n.status);
END $$;
COMMENT ON FUNCTION public.record_capture_run(jsonb) IS
 'The one writer of context_capture_runs. Creates or updates one run row; a finished run is immutable. Refusal codes: capture_run_invalid, capture_run_source_invalid, capture_run_status_invalid, capture_run_counts_invalid, capture_run_error_code_invalid, capture_run_error_code_required, capture_run_source_mismatch, capture_run_finished, capture_run_conflict.';

-- 8. Grants. Every new or re-created function: no PUBLIC, anon or
-- authenticated execute; service_role only.
REVOKE ALL ON FUNCTION
 public.context_linked_status(text),public.context_unplaced_for_job(uuid),
 public.context_source_freshness_policy(),public.context_in_business_hours(timestamptz),public.context_business_minutes(timestamptz,timestamptz),
 public.context_source_freshness(),public.context_core_status(),public.context_cadence_status(),public.context_ghl_capture_status(),
 public.context_booking_capture_status(),public.context_parties_status(),public.context_pipeline_status(),public.record_capture_run(jsonb)
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION
 public.context_linked_status(text),public.context_unplaced_for_job(uuid),
 public.context_source_freshness_policy(),public.context_in_business_hours(timestamptz),public.context_business_minutes(timestamptz,timestamptz),
 public.context_source_freshness(),public.context_core_status(),public.context_cadence_status(),public.context_ghl_capture_status(),
 public.context_booking_capture_status(),public.context_parties_status(),public.context_pipeline_status(),public.record_capture_run(jsonb)
TO service_role;
