-- FU21: one-transaction refill pages and one event build per batch.
-- No refresh, reader, trigger, schedule or flag is activated on merge.
-- Built from main 20261117195801. Guards hash pg_proc.prosrc.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
DO $guard$ DECLARE actual text; BEGIN
 SELECT md5(prosrc) INTO actual FROM pg_proc WHERE oid='public.job_profit_refresh_many(uuid[])'::regprocedure;
 IF actual <> 'b82dc4d9fc789fdaafb47eb818a571ca' THEN RAISE EXCEPTION 'FU21 rollback pre-image changed: job_profit_refresh_many'; END IF;
 SELECT md5(prosrc) INTO actual FROM pg_proc WHERE oid='public.job_profit_refresh_all()'::regprocedure;
 IF actual <> '1a06107e14830e6902b2c93f04d7410f' THEN RAISE EXCEPTION 'FU21 rollback pre-image changed: job_profit_refresh_all'; END IF;
 SELECT md5(prosrc) INTO actual FROM pg_proc WHERE oid='public.job_profit_refresh_all(uuid,integer)'::regprocedure;
 IF actual <> '6488957a919cbdd0e71d5e808010a14f' THEN RAISE EXCEPTION 'FU21 rollback pre-image changed: job_profit_refresh_all batch'; END IF;
END $guard$;
DROP FUNCTION public.job_profit_refresh_all(uuid,integer);
CREATE OR REPLACE FUNCTION public.job_profit_refresh_many(p_job_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE
 v_start timestamptz;
 v_ids uuid[];
 v_id uuid;
 v_pair text[];
 v_cols text;
 v_changed uuid[];
 v_refreshed integer;
/* function block */ BEGIN
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
 FOREACH v_pair SLICE 1 IN ARRAY ARRAY[
  ['v_job_cost_events','job_cost_events_stored'],
  ['v_job_revenue_events','job_revenue_events_stored'],
  ['v_job_profit','job_profit_stored']
 ] LOOP
  SELECT string_agg(quote_ident(a.column_name),',' ORDER BY a.ordinal_position) INTO v_cols
  FROM information_schema.columns a JOIN information_schema.columns b ON b.table_schema='public' AND b.table_name=v_pair[2] AND b.column_name=a.column_name
  WHERE a.table_schema='public' AND a.table_name=v_pair[1];
  EXECUTE format('DELETE FROM public.%I WHERE job_id=ANY($1)',v_pair[2]) USING v_ids;
  EXECUTE format('INSERT INTO public.%I (%s,computed_at) SELECT %s,clock_timestamp() FROM public.%I WHERE job_id=ANY($1)',v_pair[2],v_cols,v_cols,v_pair[1]) USING v_ids;
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
 DROP TABLE pg_temp.job_profit_refresh_before;
 RETURN jsonb_build_object('refreshed',v_refreshed,'changed',coalesce(cardinality(v_changed),0),'ms',extract(epoch FROM clock_timestamp()-v_start)*1000);
END $fn$;

CREATE OR REPLACE FUNCTION public.job_profit_refresh_all() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_start timestamptz:=clock_timestamp(); v_after uuid; v_ids uuid[]; v_total bigint:=0; v_result jsonb;
/* function block */ BEGIN
 LOOP
  -- jobs_pkey serves this keyset page. No offset or unbounded retained history.
  SELECT array_agg(id ORDER BY id) INTO v_ids FROM (
   SELECT id FROM public.jobs WHERE v_after IS NULL OR id>v_after ORDER BY id LIMIT 500
  ) s;
  EXIT WHEN v_ids IS NULL;
  v_result:=public.job_profit_refresh_many(v_ids);
  v_total:=v_total+(v_result->>'refreshed')::bigint;
  v_after:=v_ids[cardinality(v_ids)];
 END LOOP;
 RETURN jsonb_build_object('refreshed',v_total,'ms',extract(epoch FROM clock_timestamp()-v_start)*1000);
END $fn$;
