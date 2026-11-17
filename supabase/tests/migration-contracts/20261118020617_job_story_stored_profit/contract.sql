-- Restore our objects after historical contracts temporarily restore pre-images.
SELECT position('story-stored-profit-v1' IN prosrc)>0 AS stored_profit_installed FROM pg_proc WHERE oid='public.context_job_story_book(uuid,timestamptz)'::regprocedure \gset
\if :stored_profit_installed
\else
\ir ../../../migrations/20261118020617_job_story_stored_profit.sql
\endif
BEGIN;
CREATE FUNCTION pg_temp.prove(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'stored story profit: %',label; END IF; END $$;
SELECT pg_temp.prove(NOT enabled,'seed off') FROM feature_flags WHERE flag_name='job_story_stored_profit_v1';
INSERT INTO jobs(id,org_id,job_number,type,status,created_at) VALUES
 ('00000000-0000-4000-8000-000000000981','00000000-0000-0000-0000-000000000001','ZZTEST-981','fencing','accepted','2026-10-01');
DO $test$
DECLARE j uuid := '00000000-0000-4000-8000-000000000981'; expected jsonb; got jsonb; f text; stamp timestamptz; plan jsonb; rel text;
BEGIN
 expected:=context_job_story_book_profit_live(j);
 PERFORM pg_temp.prove(context_job_story_book(j,clock_timestamp())=expected,'off equals main every field');
 DELETE FROM feature_flags WHERE flag_name='job_story_stored_profit_v1';
 PERFORM pg_temp.prove(context_job_story_book(j,clock_timestamp())=expected,'missing switch equals main');
 INSERT INTO feature_flags(flag_name,enabled) VALUES('job_story_stored_profit_v1',true);
 PERFORM pg_temp.prove(context_job_story_book(j,clock_timestamp())=expected,'missing stored row falls back');
 SET LOCAL statement_timeout = '120s';
 PERFORM job_profit_refresh(j);
 SELECT computed_at INTO stamp FROM job_profit_stored WHERE job_id=j;
 got:=context_job_story_book(j,clock_timestamp());
 PERFORM pg_temp.prove(got-'computed_at'=expected AND (got->>'computed_at')::timestamptz=stamp,'stored equals main and carries exact as-at');
 PERFORM pg_temp.prove((SELECT to_jsonb(s)-'computed_at' FROM job_profit_stored s WHERE job_id=j)
   =(SELECT to_jsonb(v) FROM v_job_profit v WHERE job_id=j),'null figures copied without zero defaults');
 -- The real refresh stamps events earlier than the summary, per row.
 INSERT INTO job_cost_events_stored(job_id,source,is_actual,amount_ex,computed_at)
 VALUES(j,'fixture',false,0,stamp-interval '1 microsecond');
 INSERT INTO job_revenue_events_stored(job_id,counts_as_invoiced,amount_ex,computed_at)
 VALUES(j,false,0,stamp-interval '1 microsecond');
 PERFORM pg_temp.prove(context_job_story_book(j,clock_timestamp())-'computed_at'=expected
  AND context_job_story_book(j,clock_timestamp()) ? 'computed_at','per-row event timestamps accept the complete refresh');
 UPDATE job_cost_events_stored SET computed_at=stamp+interval '1 second' WHERE job_id=j;
 PERFORM pg_temp.prove(context_job_story_book(j,clock_timestamp())=expected,'later event snapshot falls back');
 UPDATE job_cost_events_stored SET computed_at=stamp-interval '1 microsecond' WHERE job_id=j;
 UPDATE job_profit_stored SET quoted_ex=987.65 WHERE job_id=j;
 PERFORM pg_temp.prove(context_job_story_book(j,clock_timestamp()) ? 'computed_at'
  AND context_job_story_book(j,clock_timestamp())->>'digest' IS DISTINCT FROM expected->>'digest','stored figures actually supply the book');
 UPDATE job_profit_stored SET quoted_ex=(SELECT quoted_ex FROM v_job_profit WHERE job_id=j) WHERE job_id=j;
 PERFORM pg_temp.prove((SELECT profit_ex IS NULL FROM job_profit_stored WHERE job_id=j)
  AND context_job_story_book(j,clock_timestamp())->>'lines' LIKE '%Margin: Unknown%','unknown profit remains unknown in the book');
 -- Timestamp movement alone must not change the money digest.
 UPDATE job_profit_stored SET computed_at=computed_at-interval '1 second' WHERE job_id=j;
 UPDATE job_cost_events_stored SET computed_at=stamp-interval '1 second' WHERE job_id=j;
 UPDATE job_revenue_events_stored SET computed_at=stamp-interval '1 second' WHERE job_id=j;
 PERFORM pg_temp.prove(context_job_story_book(j,clock_timestamp())->>'digest'=expected->>'digest','as-at is outside digest');
 -- An office edit marks the job; the latest live answer wins immediately.
 INSERT INTO job_profit_dirty(job_id,reason) VALUES(j,'office');
 UPDATE job_profit_stored SET quoted_ex=987.65 WHERE job_id=j;
 PERFORM pg_temp.prove(context_job_story_book(j,clock_timestamp())=expected,'dirty office change falls back');
 DELETE FROM job_profit_dirty WHERE job_id=j;
 UPDATE job_profit_stored SET computed_at=now()-interval '2 days' WHERE job_id=j;
 PERFORM pg_temp.prove(context_job_story_book(j,clock_timestamp())=expected,'date-based holds use live until daily refresh');
 SET LOCAL statement_timeout = '120s';
 PERFORM job_profit_refresh(j);
 SELECT pg_get_functiondef('public.context_job_story_book_profit_stored(uuid,timestamptz)'::regprocedure) INTO f;
 EXECUTE $sql$CREATE OR REPLACE FUNCTION public.context_job_story_book_profit_stored(p_job_id uuid,p_as_of timestamptz DEFAULT now())
 RETURNS jsonb LANGUAGE plpgsql STABLE AS $bad$ BEGIN RAISE EXCEPTION 'fixture read refused'; END $bad$$sql$;
 PERFORM pg_temp.prove(context_job_story_book(j,clock_timestamp())=expected,'stored read error falls back');
 PERFORM pg_temp.prove(context_job_story_book(j,clock_timestamp())=expected,'retry after refusal still falls back');
 EXECUTE f;
 PERFORM pg_temp.prove(context_job_story_book(j,clock_timestamp())-'computed_at'=expected,'retry after recovery uses store');
 -- The existing staff money envelope exposes the as-at coordinate too.
 got:=context_job_story_text_get(j,jsonb_build_object('job',jsonb_build_object('id',j),'book',context_job_story_book(j,clock_timestamp())),false);
 PERFORM pg_temp.prove(got#>>'{money,computed_at}' IS NOT NULL,'staff money carries as-at');
 UPDATE feature_flags SET enabled=false WHERE flag_name='job_story_stored_profit_v1';
 PERFORM pg_temp.prove(context_job_story_text_get(j,jsonb_build_object('job',jsonb_build_object('id',j)),false)
  =context_job_story_text_get_profit_live(j,jsonb_build_object('job',jsonb_build_object('id',j)),false),'staff off answer identical');
 PERFORM pg_temp.prove(context_job_story_text_get(j,jsonb_build_object('book',got->'money'||jsonb_build_object('job_id',j)),false)
  =context_job_story_text_get_profit_live(j,jsonb_build_object('book',got->'money'||jsonb_build_object('job_id',j)),false),'off drops cached stored as-at exactly like main');
 PERFORM pg_temp.prove(context_job_story_book(NULL) IS NULL,'unknown job stays unknown');
 -- Check the actual access plan, not an index name. These are job-key reads.
 PERFORM set_config('enable_seqscan','off',true);
 FOREACH rel IN ARRAY ARRAY['job_profit_stored','job_profit_dirty','job_cost_events_stored','job_revenue_events_stored'] LOOP
  EXECUTE format('EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM public.%I WHERE job_id=$1',rel) INTO plan USING j;
  PERFORM pg_temp.prove(plan::text NOT LIKE '%Seq Scan%' AND plan::text LIKE '%Index%'
   AND NOT EXISTS(SELECT 1 FROM jsonb_path_query(plan,'$.**."Actual Rows"') n WHERE n::text::numeric>1),'indexed per-job read '||rel);
 END LOOP;
 PERFORM pg_temp.prove(NOT has_function_privilege('anon','public.context_job_story_book_profit_stored(uuid,timestamptz)','EXECUTE'),'private stored implementation');
END $test$;
\ir ../../../migrations/20261118020617_job_story_stored_profit.sql
SELECT pg_temp.prove(NOT enabled,'reapply keeps switch off') FROM feature_flags WHERE flag_name='job_story_stored_profit_v1';
ROLLBACK;
\echo PASS: stored story profit contract (22 behavior checks and 4 indexed plans)
