-- FU21: one-transaction refill pages and one event build per batch.
-- No refresh, reader, trigger, schedule or flag is activated on merge.
-- Built from main 20261117195801. Guards hash pg_proc.prosrc.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
DO $guard$ DECLARE actual text; BEGIN
 SELECT md5(prosrc) INTO actual FROM pg_proc WHERE oid='public.job_profit_refresh_many(uuid[])'::regprocedure;
 IF actual NOT IN ('877abfec69a00105409c7ac074abaae2','b82dc4d9fc789fdaafb47eb818a571ca') THEN RAISE EXCEPTION 'FU21 pre-image changed: job_profit_refresh_many (%)',actual; END IF;
 SELECT md5(prosrc) INTO actual FROM pg_proc WHERE oid='public.job_profit_refresh_all()'::regprocedure;
 IF actual NOT IN ('99b614deb63fea33b79415d968001b6c','1a06107e14830e6902b2c93f04d7410f') THEN RAISE EXCEPTION 'FU21 pre-image changed: job_profit_refresh_all (%)',actual; END IF;
 IF to_regprocedure('public.job_profit_refresh_all(uuid,integer)') IS NOT NULL THEN
  SELECT md5(prosrc) INTO actual FROM pg_proc WHERE oid='public.job_profit_refresh_all(uuid,integer)'::regprocedure;
  IF actual <> '6488957a919cbdd0e71d5e808010a14f' THEN RAISE EXCEPTION 'FU21 pre-image changed: job_profit_refresh_all batch (%)',actual; END IF;
 END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.job_profit_refresh_many(p_job_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='5s' AS $fn$
DECLARE
 v_start timestamptz;
 v_ids uuid[];
 v_id uuid;
 v_pair text[];
 v_cols text;
 v_changed uuid[];
 v_refreshed integer;
 v_profit_sql text;
/* function block */ BEGIN
 -- Set the deadline BEFORE this statement starts, not from inside the function.
 IF current_setting('statement_timeout')::interval NOT BETWEEN interval '1 millisecond' AND interval '120 seconds' THEN
  RAISE EXCEPTION 'job_profit_refresh_requires_timeout_120s_or_less';
 END IF;
 IF coalesce(cardinality(p_job_ids),0)=0 THEN RETURN '{"refreshed":0,"changed":0,"ms":0}'::jsonb; END IF;
 IF cardinality(p_job_ids)>500 THEN RAISE EXCEPTION 'job_profit_refresh_too_many'; END IF;
 SELECT array_agg(id ORDER BY id) INTO v_ids FROM (SELECT DISTINCT unnest(p_job_ids) id) s WHERE id IS NOT NULL;
 IF v_ids IS NULL THEN RETURN '{"refreshed":0,"changed":0,"ms":0}'::jsonb; END IF;
 -- Refreshes of overlapping batches serialize in stable order. These locks are
 -- private to this background writer, never taken by a business-table write.
 FOREACH v_id IN ARRAY v_ids LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('job_profit_stored:'||v_id::text,0));
 END LOOP;
 v_start:=clock_timestamp();
 -- Stored job primary key bounds this snapshot to the requested batch.
 CREATE TEMP TABLE job_profit_refresh_before ON COMMIT DROP AS
 SELECT job_id,to_jsonb(s)-'computed_at' AS figures FROM public.job_profit_stored s WHERE job_id=ANY(v_ids);
 -- The legacy event views include company-wide bill/credit work even behind
 -- a job filter. Build once, then use those same rows in the profit SELECT.
 CREATE TEMP TABLE job_profit_refresh_cost ON COMMIT DROP AS
 SELECT * FROM public.v_job_cost_events WHERE job_id=ANY(v_ids);
 CREATE TEMP TABLE job_profit_refresh_revenue ON COMMIT DROP AS
 SELECT * FROM public.v_job_revenue_events WHERE job_id=ANY(v_ids);
 v_profit_sql:=pg_get_viewdef('public.v_job_profit'::regclass,true);
 -- Substitute relation tokens only in the trusted main view definition. Its
 -- financial expressions and all public views remain unchanged. Each stream
 -- is grouped/joined by job_id in main, so the requested batch is sufficient.
 v_profit_sql:=regexp_replace(v_profit_sql,'\m(public\.)?v_job_cost_events\M','pg_temp.job_profit_refresh_cost','g');
 v_profit_sql:=regexp_replace(v_profit_sql,'\m(public\.)?v_job_revenue_events\M','pg_temp.job_profit_refresh_revenue','g');
 CREATE TEMP TABLE job_profit_refresh_profit (LIKE public.v_job_profit) ON COMMIT DROP;
 EXECUTE 'INSERT INTO pg_temp.job_profit_refresh_profit SELECT * FROM ('||rtrim(v_profit_sql,E';\n ')||') p WHERE job_id=ANY($1)' USING v_ids;
 FOREACH v_pair SLICE 1 IN ARRAY ARRAY[
  ['v_job_cost_events','job_cost_events_stored','job_profit_refresh_cost'],
  ['v_job_revenue_events','job_revenue_events_stored','job_profit_refresh_revenue'],
  ['v_job_profit','job_profit_stored','job_profit_refresh_profit']
 ] LOOP
  SELECT string_agg(quote_ident(a.column_name),',' ORDER BY a.ordinal_position) INTO v_cols
  FROM information_schema.columns a JOIN information_schema.columns b ON b.table_schema='public' AND b.table_name=v_pair[2] AND b.column_name=a.column_name
  WHERE a.table_schema='public' AND a.table_name=v_pair[1];
  -- Stored profit primary key and event job_id indexes bound these writes.
  EXECUTE format('DELETE FROM public.%I WHERE job_id=ANY($1)',v_pair[2]) USING v_ids;
  EXECUTE format('INSERT INTO public.%I (%s,computed_at) SELECT %s,clock_timestamp() FROM pg_temp.%I',v_pair[2],v_cols,v_cols,v_pair[3]);
 END LOOP;
 -- Compare both sides, including a job that disappeared from the checking view.
 SELECT array_agg(coalesce(n.job_id,o.job_id) ORDER BY coalesce(n.job_id,o.job_id)) INTO v_changed
 FROM (SELECT * FROM public.job_profit_stored WHERE job_id=ANY(v_ids)) n
 FULL JOIN pg_temp.job_profit_refresh_before o USING(job_id)
 WHERE (to_jsonb(n)-'computed_at') IS DISTINCT FROM o.figures;
 SELECT count(*) INTO v_refreshed FROM public.job_profit_stored WHERE job_id=ANY(v_ids);
 DELETE FROM public.job_profit_dirty WHERE job_id=ANY(v_ids) AND marked_at<v_start;
 IF to_regprocedure('public.job_mark_changed(uuid,text)') IS NOT NULL AND v_changed IS NOT NULL THEN
  FOREACH v_id IN ARRAY v_changed LOOP
   EXECUTE 'SELECT public.job_mark_changed($1,$2)' USING v_id,'profit';
  END LOOP;
 END IF;
 DROP TABLE pg_temp.job_profit_refresh_before,pg_temp.job_profit_refresh_cost,pg_temp.job_profit_refresh_revenue,pg_temp.job_profit_refresh_profit;
 RETURN jsonb_build_object('refreshed',v_refreshed,'changed',coalesce(cardinality(v_changed),0),'ms',extract(epoch FROM clock_timestamp()-v_start)*1000);
END $fn$;

-- The retired unbounded entry point now refuses instead of returning a summary.
-- output-key-guard: drop public.job_profit_refresh_all refreshed
-- output-key-guard: drop public.job_profit_refresh_all ms
CREATE OR REPLACE FUNCTION public.job_profit_refresh_all() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
/* function block */ BEGIN
 RAISE EXCEPTION 'job_profit_refresh_all_requires_batch_cursor' USING HINT='Call job_profit_refresh_all(NULL::uuid,500), commit, then pass next_after in a new transaction until done. Set statement_timeout before every call to at most 120s.';
END $fn$;

CREATE OR REPLACE FUNCTION public.job_profit_refresh_all(p_after uuid,p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='5s' AS $fn$
DECLARE v_ids uuid[]; v_result jsonb; v_more boolean;
/* function block */ BEGIN
 IF current_setting('statement_timeout')::interval NOT BETWEEN interval '1 millisecond' AND interval '120 seconds' THEN
  RAISE EXCEPTION 'job_profit_refresh_requires_timeout_120s_or_less';
 END IF;
 IF to_regclass('pg_temp.job_profit_refill_page') IS NOT NULL THEN
  RAISE EXCEPTION 'job_profit_refresh_all_commit_before_next_batch';
 END IF;
 CREATE TEMP TABLE job_profit_refill_page(page_started boolean) ON COMMIT DROP;
 IF p_limit IS NULL OR p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'job_profit_refresh_batch_limit'; END IF;
 -- jobs_pkey serves two direct keyset ranges, never an unbounded nullable OR.
 IF p_after IS NULL THEN
  SELECT array_agg(id ORDER BY id) INTO v_ids FROM (SELECT id FROM public.jobs ORDER BY id LIMIT p_limit+1) s;
 ELSE
  SELECT array_agg(id ORDER BY id) INTO v_ids FROM (SELECT id FROM public.jobs WHERE id>p_after ORDER BY id LIMIT p_limit+1) s;
 END IF;
 v_more:=coalesce(cardinality(v_ids),0)>p_limit;
 v_ids:=v_ids[1:p_limit];
 v_result:=public.job_profit_refresh_many(v_ids);
 -- Exactly ONE batch. The caller commits before the next page so its private
 -- transaction advisory locks cannot accumulate across the company refill.
 RETURN v_result||jsonb_build_object('next_after',v_ids[cardinality(v_ids)],'done',NOT v_more);
END $fn$;
REVOKE ALL ON FUNCTION public.job_profit_refresh_all(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit_refresh_all(uuid,integer) TO service_role;
