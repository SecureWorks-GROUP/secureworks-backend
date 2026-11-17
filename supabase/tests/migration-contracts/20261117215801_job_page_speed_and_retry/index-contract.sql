-- Natural planner settings, with handled history and a single pending job.
BEGIN;
INSERT INTO public.jobs(id,org_id,type,status,job_number)
SELECT md5('ZZTEST-page-plan-'||g)::uuid,'00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-PLAN-'||g
FROM generate_series(1,1000) g;
INSERT INTO public.job_change_mark_events(job_id,source,page_pending)
SELECT md5('ZZTEST-page-plan-'||((g-1)%1000+1))::uuid,'message',false FROM generate_series(1,10000) g;
INSERT INTO public.job_change_marks_base(job_id,page_pending)
SELECT md5('ZZTEST-page-plan-'||g)::uuid,false FROM generate_series(1,1000) g;
SELECT public.job_mark_changed(md5('ZZTEST-page-plan-1')::uuid,'message');
ANALYZE public.job_change_mark_events;
ANALYZE public.job_change_marks_base;
DO $c$
DECLARE query text; plan jsonb; target regclass;
BEGIN
 SELECT prosrc INTO query FROM pg_proc WHERE oid='public.job_page_yield(uuid)'::regprocedure;
 query:=replace(query,'p_job_id',quote_literal(md5('ZZTEST-page-plan-1')::uuid)||'::uuid');
 EXECUTE 'EXPLAIN (ANALYZE,FORMAT JSON) '||query INTO plan;
 -- Require real indexed access on BOTH updated tables, independent of name.
 -- The fixture has 1,000 jobs/10,000 marks; one job must read at most 32 rows,
 -- including rows rejected by a filter, with natural planner settings.
 FOREACH target IN ARRAY ARRAY['public.job_change_mark_events'::regclass,'public.job_change_marks_base'::regclass] LOOP
  IF EXISTS (
   SELECT 1 FROM jsonb_path_query(plan, '$.** ? (@."Node Type" == "Seq Scan")') AS p(node)
   WHERE p.node->>'Relation Name' = (SELECT relname FROM pg_class WHERE oid=target)
  ) OR EXISTS (
   SELECT 1 FROM jsonb_path_query(plan, '$.** ? (exists(@."Relation Name"))') AS p(node)
   WHERE p.node->>'Relation Name' = (SELECT relname FROM pg_class WHERE oid=target)
    AND (coalesce((p.node->>'Actual Rows')::numeric,0)
      + coalesce((p.node->>'Rows Removed by Filter')::numeric,0)
      + coalesce((p.node->>'Rows Removed by Index Recheck')::numeric,0))
      * coalesce((p.node->>'Actual Loops')::numeric,0) > 32
  ) OR NOT EXISTS (
   SELECT 1 FROM jsonb_path_query(plan, '$.** ? (exists(@."Index Name"))') AS p(node)
   JOIN pg_class c ON c.relname = p.node->>'Index Name'
   JOIN pg_index i ON i.indexrelid = c.oid AND i.indrelid=target
  ) THEN
   RAISE EXCEPTION 'page retry: one-job yield did not use its indexes: %',plan;
  END IF;
 END LOOP;
END $c$;
-- With a dense pending queue the job-leading indexes must bound the update.
UPDATE public.job_change_mark_events SET page_pending=true;
UPDATE public.job_change_marks_base SET page_pending=true;
ANALYZE public.job_change_mark_events;
ANALYZE public.job_change_marks_base;
DO $c$
DECLARE query text; plan jsonb; target regclass;
BEGIN
 SELECT prosrc INTO query FROM pg_proc WHERE oid='public.job_page_yield(uuid)'::regprocedure;
 query:=replace(query,'p_job_id',quote_literal(md5('ZZTEST-page-plan-1')::uuid)||'::uuid');
 EXECUTE 'EXPLAIN (ANALYZE,FORMAT JSON) '||query INTO plan;
 -- Require real indexed access on BOTH updated tables, independent of name.
 -- The fixture has 1,000 jobs/10,000 marks; one job must read at most 32 rows,
 -- including rows rejected by a filter, with natural planner settings.
 FOREACH target IN ARRAY ARRAY['public.job_change_mark_events'::regclass,'public.job_change_marks_base'::regclass] LOOP
  IF EXISTS (
   SELECT 1 FROM jsonb_path_query(plan, '$.** ? (@."Node Type" == "Seq Scan")') AS p(node)
   WHERE p.node->>'Relation Name' = (SELECT relname FROM pg_class WHERE oid=target)
  ) OR EXISTS (
   SELECT 1 FROM jsonb_path_query(plan, '$.** ? (exists(@."Relation Name"))') AS p(node)
   WHERE p.node->>'Relation Name' = (SELECT relname FROM pg_class WHERE oid=target)
    AND (coalesce((p.node->>'Actual Rows')::numeric,0)
      + coalesce((p.node->>'Rows Removed by Filter')::numeric,0)
      + coalesce((p.node->>'Rows Removed by Index Recheck')::numeric,0))
      * coalesce((p.node->>'Actual Loops')::numeric,0) > 32
  ) OR NOT EXISTS (
   SELECT 1 FROM jsonb_path_query(plan, '$.** ? (exists(@."Index Name"))') AS p(node)
   JOIN pg_class c ON c.relname = p.node->>'Index Name'
   JOIN pg_index i ON i.indexrelid = c.oid AND i.indrelid=target
   JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0]
   WHERE a.attname='job_id' AND position('job_id =' IN p.node->>'Index Cond') > 0
  ) THEN
   RAISE EXCEPTION 'page retry: dense queue yield did not use job-leading indexes: %',plan;
  END IF;
 END LOOP;
END $c$;
ROLLBACK;
