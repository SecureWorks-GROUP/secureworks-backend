-- Actual query plans, natural planner settings, 10,000 handled marks on other jobs.
BEGIN;
INSERT INTO public.jobs(id,org_id,type,status,job_number)
SELECT md5('ZZTEST-index-'||g)::uuid,'00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-INDEX-'||g
FROM generate_series(1,100) g;
INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES
 ('00000000-0000-4000-8000-000000000456','00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-456');
INSERT INTO public.job_change_mark_events(job_id,source,page_pending)
SELECT md5('ZZTEST-index-'||((g-1)%100+1))::uuid,'message',false FROM generate_series(1,10000) g;
SELECT public.job_mark_changed('00000000-0000-4000-8000-000000000456','message');
ANALYZE public.job_change_mark_events;
ANALYZE public.job_change_marks_base;
ANALYZE public.jobs;
CREATE TEMP TABLE before_fold ON COMMIT DROP AS SELECT job_id,mark_version FROM public.job_change_marks;
DO $c$
DECLARE plan jsonb; query text; v_before bigint;
BEGIN
 SELECT prosrc INTO query FROM pg_proc WHERE oid='public.job_pages_next_due()'::regprocedure;
 EXECUTE 'EXPLAIN (FORMAT JSON) '||query INTO plan;
 RAISE NOTICE 'due plan: %',plan;
 IF jsonb_path_exists(plan,'$.** ? (@."Node Type" == "Seq Scan" && @."Relation Name" == "job_change_mark_events")')
  OR NOT plan::text LIKE '%job_change_mark_events_due%' THEN
  RAISE EXCEPTION 'queue safety: next due did not use the event due index: %',plan;
 END IF;
 IF public.job_pages_next_due() IS DISTINCT FROM '00000000-0000-4000-8000-000000000456'::uuid THEN
  RAISE EXCEPTION 'queue safety: due probe selected handled work'; END IF;
 EXECUTE $q$EXPLAIN (FORMAT JSON) SELECT mark_version FROM public.job_change_marks
  WHERE job_id='00000000-0000-4000-8000-000000000456'$q$ INTO plan;
 RAISE NOTICE 'version plan: %',plan;
 IF jsonb_path_exists(plan,'$.** ? (@."Node Type" == "Seq Scan" && @."Relation Name" == "job_change_mark_events")')
  OR NOT plan::text LIKE '%job_change_mark_events_job%' THEN
  RAISE EXCEPTION 'queue safety: one version did not use the job index: %',plan;
 END IF;
 SELECT count(*) INTO v_before FROM public.job_change_mark_events;
 PERFORM public.job_change_marks_fold(5000);
 IF (SELECT count(*) FROM public.job_change_mark_events)<>v_before-5000 THEN
  RAISE EXCEPTION 'queue safety: fold exceeded its bound or did not remove handled events'; END IF;
 IF EXISTS(SELECT 1 FROM before_fold b FULL JOIN public.job_change_marks m USING(job_id)
  WHERE b.mark_version IS DISTINCT FROM m.mark_version) THEN
  RAISE EXCEPTION 'queue safety: fold changed a version'; END IF;
 PERFORM public.job_change_marks_fold(10000);
 IF (SELECT count(*) FROM public.job_change_mark_events)<>1 THEN
  RAISE EXCEPTION 'queue safety: fold did not leave a small table with the pending event'; END IF;
 IF EXISTS(SELECT 1 FROM before_fold b FULL JOIN public.job_change_marks m USING(job_id)
  WHERE b.mark_version IS DISTINCT FROM m.mark_version) THEN
  RAISE EXCEPTION 'queue safety: second fold changed a version'; END IF;
 IF public.job_pages_next_due() IS DISTINCT FROM '00000000-0000-4000-8000-000000000456'::uuid THEN
  RAISE EXCEPTION 'queue safety: fold consumed pending work'; END IF;
END $c$;
ROLLBACK;
