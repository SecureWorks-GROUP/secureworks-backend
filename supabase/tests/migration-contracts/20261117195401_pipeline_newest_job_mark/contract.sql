-- Earlier job-page contracts roll their successor back and recreate the marks
-- heap without our indexes. Restore our own migration before measuring its plan.
\ir ../../../migrations/20261117195401_pipeline_newest_job_mark.sql
BEGIN;
-- Isolate from registered-stack marks and wall-clock fixture dates; rollback restores all.
DELETE FROM public.job_change_mark_events;
DELETE FROM public.job_change_marks_base;
-- Older marks from our org, a newer foreign-org mark, and a newest orphan.
INSERT INTO public.jobs(id,org_id,type,status,job_number)
SELECT md5('ZZTEST-FU13-'||g)::uuid,
 CASE WHEN g%2=0 THEN '00000000-0000-0000-0000-000000000001'::uuid
 ELSE '00000000-0000-0000-0000-000000000002'::uuid END,
 'fencing','accepted','ZZTEST-FU13-'||g FROM generate_series(1,1000) g;
INSERT INTO public.job_change_marks_base(job_id,last_marked_at)
SELECT md5('ZZTEST-FU13-'||g)::uuid,'2026-11-16T01:00:00Z'::timestamptz
 +g*interval '1 second' FROM generate_series(1,1000) g;
-- A foreign org's newer folded mark must not win over our event.
UPDATE public.job_change_marks_base SET last_marked_at='2026-11-18T02:30:00Z'
 WHERE job_id=md5('ZZTEST-FU13-1')::uuid;
INSERT INTO public.job_change_mark_events(job_id,marked_at,source,page_pending)
SELECT md5('ZZTEST-FU13-'||((g-1)%1000+1))::uuid,
 '2026-11-17T01:00:00Z'::timestamptz+g*interval '1 second','message',false
 FROM generate_series(1,20000) g;
INSERT INTO public.job_change_mark_events(job_id,marked_at,source,page_pending) VALUES
 (md5('ZZTEST-FU13-2')::uuid,'2026-11-18T01:00:00Z','invoice',false),
 (md5('ZZTEST-FU13-1')::uuid,'2026-11-18T02:00:00Z','booking',true),
 (md5('ZZTEST-FU13-orphan')::uuid,'2026-11-18T03:00:00Z','message',true);
ANALYZE public.jobs;
ANALYZE public.job_change_mark_events;
ANALYZE public.job_change_marks_base;
DO $check$
DECLARE plan jsonb; relation_name text;
BEGIN
 IF (SELECT last_marked_at FROM public.pipeline_newest_job_mark('00000000-0000-0000-0000-000000000001'))
  IS DISTINCT FROM '2026-11-18T01:00:00Z'::timestamptz THEN
  RAISE EXCEPTION 'FU13: newest handled mark lost, foreign org or orphan leaked'; END IF;
 IF (SELECT last_marked_at FROM public.pipeline_newest_job_mark('00000000-0000-0000-0000-000000000002'))
  IS DISTINCT FROM '2026-11-18T02:30:00Z'::timestamptz THEN
  RAISE EXCEPTION 'FU13: second org newest mark incorrect'; END IF;
 IF EXISTS(SELECT FROM public.pipeline_newest_job_mark('00000000-0000-0000-0000-000000000003'))
  OR EXISTS(SELECT FROM public.pipeline_newest_job_mark(NULL)) THEN
  RAISE EXCEPTION 'FU13: empty or absent org must have no mark'; END IF;
 IF has_function_privilege('anon','public.pipeline_newest_job_mark(uuid)','EXECUTE')
  OR has_function_privilege('authenticated','public.pipeline_newest_job_mark(uuid)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.pipeline_newest_job_mark(uuid)','EXECUTE') THEN
  RAISE EXCEPTION 'FU13: read must be service-role only'; END IF;
 -- EXPLAIN the actual inlinable RPC with natural planner settings.
 EXECUTE $q$EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
  SELECT * FROM public.pipeline_newest_job_mark('00000000-0000-0000-0000-000000000001')$q$ INTO plan;
 RAISE NOTICE 'FU13 newest mark plan: %',plan;
 -- Equivalent indexes may have different names. Assert the executed access
 -- paths for each relation, retaining the natural planner and row fixture.
 FOREACH relation_name IN ARRAY ARRAY['job_change_mark_events', 'job_change_marks_base', 'jobs'] LOOP
  IF NOT jsonb_path_exists(plan,
    '$.** ? (@."Relation Name" == $relation && (@."Node Type" == "Index Scan" || @."Node Type" == "Index Only Scan"))',
    jsonb_build_object('relation', relation_name))
   OR jsonb_path_exists(plan,
    '$.** ? (@."Relation Name" == $relation && @."Node Type" == "Seq Scan")',
    jsonb_build_object('relation', relation_name)) THEN
   RAISE EXCEPTION 'FU13: newest org mark must use an index scan on %', relation_name;
  END IF;
 END LOOP;
END $check$;
-- A booking-only event must advance the same org's reader too.
INSERT INTO public.job_change_mark_events(job_id,marked_at,source,page_pending) VALUES
 (md5('ZZTEST-FU13-2')::uuid,'2026-11-18T04:00:00Z','booking',true);
DO $check$ BEGIN
 IF (SELECT last_marked_at FROM public.pipeline_newest_job_mark('00000000-0000-0000-0000-000000000001'))
  IS DISTINCT FROM '2026-11-18T04:00:00Z'::timestamptz THEN
  RAISE EXCEPTION 'FU13: booking-only mark did not advance stamp'; END IF;
END $check$;
-- Reproduce the fold's handoff: save the newest event time on the base row,
-- then remove handled events. The stamp must remain identical, not regress.
UPDATE public.job_change_marks_base SET last_marked_at='2026-11-18T04:00:00Z'
 WHERE job_id=md5('ZZTEST-FU13-2')::uuid;
DELETE FROM public.job_change_mark_events WHERE job_id=md5('ZZTEST-FU13-2')::uuid;
DO $check$ BEGIN
 IF (SELECT last_marked_at FROM public.pipeline_newest_job_mark('00000000-0000-0000-0000-000000000001'))
  IS DISTINCT FROM '2026-11-18T04:00:00Z'::timestamptz THEN
  RAISE EXCEPTION 'FU13: folded newest event disappeared from the stamp'; END IF;
END $check$;
-- Base-only marks still count after the event heap is completely folded away.
DELETE FROM public.job_change_mark_events;
DO $check$ BEGIN
 IF (SELECT last_marked_at FROM public.pipeline_newest_job_mark('00000000-0000-0000-0000-000000000001'))
  IS DISTINCT FROM '2026-11-18T04:00:00Z'::timestamptz THEN
  RAISE EXCEPTION 'FU13: base-only mark disappeared from the stamp'; END IF;
END $check$;
ROLLBACK;
\echo FU13 newest-mark contract passed (org isolation, handled and folded marks, empty org, grants, indexed plan)
