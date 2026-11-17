-- Pending marker contract (P0-03). The worker's marker read is an index-only scan of the new index, with no row
-- filtered, sorted or scanned beside it, for an empty backlog and for one old pending row among many unplaced no-job
-- rows; its answer is the pending row with no job checked last; the index has the promised definition and comment;
-- a re-apply is a no-op. Invented rows, rolled back.
-- The marker read's plan and answer over 20,050 no-job rows that are not pending (20,000 in the admin bucket, 50
-- unplaced: the rows business_events_context_bucket holds): first with no pending row, then with one old pending row
-- checked before all of them, beside a pending row never checked and a pending row on a job, neither a marker row.
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.business_events (id, event_type, job_id, attribution_status, attribution_checked_at, occurred_at)
SELECT gen_random_uuid(), 'pm.fixture', NULL, 'admin_bucket', timestamptz '2026-10-01 00:00Z' + g * interval '1 minute',
       timestamptz '2026-10-01 00:00Z' + g * interval '1 minute'
  FROM generate_series(1, 20000) g;
INSERT INTO public.business_events (id, event_type, job_id, attribution_status, attribution_checked_at, occurred_at)
SELECT gen_random_uuid(), 'pm.fixture', NULL, 'unplaced', timestamptz '2026-11-01 00:00Z' + g * interval '1 minute', now()
  FROM generate_series(1, 50) g;
ANALYZE public.business_events;
CREATE TEMP TABLE pm_plans (label text, plan text) ON COMMIT DROP;
CREATE FUNCTION pg_temp.pm_plan(label text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE line text; whole text := '';
BEGIN
 FOR line IN EXECUTE 'EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) SELECT id, attribution_checked_at FROM public.business_events'
   || ' WHERE attribution_status = ''pending_luna'' AND job_id IS NULL AND attribution_checked_at IS NOT NULL'
   || ' ORDER BY attribution_checked_at DESC NULLS FIRST LIMIT 1' LOOP
  whole := whole || line || E'\n';
 END LOOP;
 INSERT INTO pm_plans VALUES (label, whole);
 IF whole NOT LIKE '%Index Only Scan using business_events_pending_luna_marker%' THEN
  RAISE EXCEPTION 'pending marker (%): the marker read does not use the index: %', label, whole;
 END IF;
 IF whole LIKE '%Seq Scan%' OR whole LIKE '%Sort%' OR whole LIKE '%Rows Removed by Filter%' THEN
  RAISE EXCEPTION 'pending marker (%): the marker read scans, sorts or filters rows: %', label, whole;
 END IF;
END $f$;
SELECT pg_temp.pm_plan('empty backlog');
DO $c$
BEGIN
 IF EXISTS (SELECT 1 FROM public.business_events WHERE attribution_status = 'pending_luna' AND job_id IS NULL AND attribution_checked_at IS NOT NULL) THEN
  RAISE EXCEPTION 'pending marker: the fixture backlog is not empty';
 END IF;
END $c$;
INSERT INTO public.business_events (id, event_type, job_id, attribution_status, attribution_checked_at, occurred_at)
VALUES ('4c000000-0000-4000-8000-000000000001', 'pm.fixture', NULL, 'pending_luna', '2026-09-01 00:00Z', '2026-09-01 00:00Z'),
       -- Not a marker row: a pending row never checked, and a pending row on a job.
       ('4c000000-0000-4000-8000-000000000002', 'pm.fixture', NULL, 'pending_luna', NULL, '2026-12-01 00:00Z'),
       ('4c000000-0000-4000-8000-000000000003', 'pm.fixture', gen_random_uuid(), 'pending_luna', '2026-12-01 00:00Z', '2026-12-01 00:00Z');
SELECT pg_temp.pm_plan('one old pending row');
DO $c$
DECLARE r record;
BEGIN
 SELECT id, attribution_checked_at INTO r FROM public.business_events
  WHERE attribution_status = 'pending_luna' AND job_id IS NULL AND attribution_checked_at IS NOT NULL
  ORDER BY attribution_checked_at DESC NULLS FIRST LIMIT 1;
 IF r.id IS DISTINCT FROM '4c000000-0000-4000-8000-000000000001'::uuid OR r.attribution_checked_at IS DISTINCT FROM '2026-09-01 00:00Z'::timestamptz THEN
  RAISE EXCEPTION 'pending marker: the marker read answered % at %', r.id, r.attribution_checked_at;
 END IF;
END $c$;
ROLLBACK;

-- The index itself: the promised definition and its comment.
DO $c$
DECLARE d text;
BEGIN
 SELECT pg_get_indexdef('public.business_events_pending_luna_marker'::regclass) INTO d;
 IF d IS DISTINCT FROM 'CREATE INDEX business_events_pending_luna_marker ON public.business_events USING btree (attribution_checked_at DESC) INCLUDE (id) WHERE ((job_id IS NULL) AND (attribution_status = ''pending_luna''::text) AND (attribution_checked_at IS NOT NULL))' THEN
  RAISE EXCEPTION 'pending marker: the index is not the promised shape: %', d;
 END IF;
 IF position('20261117090000' IN coalesce(obj_description('public.business_events_pending_luna_marker'::regclass, 'pg_class'), '')) = 0 THEN
  RAISE EXCEPTION 'pending marker: the index comment is missing';
 END IF;
END $c$;

-- A re-apply is a no-op: the same single index, unchanged.
BEGIN;
CREATE TEMP TABLE pm_before AS SELECT indexrelid, pg_get_indexdef(indexrelid) AS def FROM pg_index
 WHERE indexrelid = 'public.business_events_pending_luna_marker'::regclass;
\ir ../../../migrations/20261117090000_context_pending_marker_index.sql
DO $c$
BEGIN
 IF (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'business_events_pending_luna_marker') <> 1
    OR (SELECT indexrelid FROM pm_before) IS DISTINCT FROM 'public.business_events_pending_luna_marker'::regclass THEN
  RAISE EXCEPTION 'pending marker: a re-apply replaced or duplicated the index';
 END IF;
END $c$;
ROLLBACK;
