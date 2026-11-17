-- P0-09.2 and P0-09.3: empty stores and explicit service-role refreshes only.
-- No existing caller, trigger, schedule, view or budget switch changes on merge.
-- The reference is derived from migrations, not observed live. The director must
-- verify pg_get_viewdef and md5 against live before installing or switching on readers.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.job_profit_stored (LIKE public.v_job_profit);
ALTER TABLE public.job_profit_stored ADD COLUMN IF NOT EXISTS computed_at timestamptz NOT NULL DEFAULT now();
DO $key$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.job_profit_stored'::regclass AND contype='p') THEN
  ALTER TABLE public.job_profit_stored ADD PRIMARY KEY(job_id);
 END IF;
END $key$;
CREATE TABLE IF NOT EXISTS public.job_cost_events_stored (LIKE public.v_job_cost_events);
ALTER TABLE public.job_cost_events_stored ADD COLUMN IF NOT EXISTS computed_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS job_cost_events_stored_job_idx ON public.job_cost_events_stored(job_id);
CREATE TABLE IF NOT EXISTS public.job_revenue_events_stored (LIKE public.v_job_revenue_events);
ALTER TABLE public.job_revenue_events_stored ADD COLUMN IF NOT EXISTS computed_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS job_revenue_events_stored_job_idx ON public.job_revenue_events_stored(job_id);
CREATE TABLE IF NOT EXISTS public.job_profit_dirty (
 job_id uuid PRIMARY KEY,
 reason text NOT NULL,
 marked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_profit_dirty_oldest_idx ON public.job_profit_dirty(marked_at,job_id);
ALTER TABLE public.job_profit_stored ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_cost_events_stored ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_revenue_events_stored ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_profit_dirty ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_profit_stored, public.job_cost_events_stored, public.job_revenue_events_stored, public.job_profit_dirty FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_profit_stored, public.job_cost_events_stored, public.job_revenue_events_stored, public.job_profit_dirty TO service_role;
-- service_role normally bypasses RLS; keep the intended grant explicit in local roles too.
DO $policies$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['job_profit_stored','job_cost_events_stored','job_revenue_events_stored','job_profit_dirty'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='service_role_all') THEN
   EXECUTE format('CREATE POLICY service_role_all ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',t);
  END IF;
 END LOOP;
END $policies$;
INSERT INTO public.feature_flags(flag_name,enabled,description)
VALUES('job_profit_stored_read_v1',false,'Job Profit and the job story read the stored per-job tables')
ON CONFLICT(flag_name) DO NOTHING;

CREATE OR REPLACE FUNCTION public.job_profit_mark(p_job_id uuid,p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 IF p_job_id IS NULL THEN RETURN; END IF;
 INSERT INTO public.job_profit_dirty(job_id,reason,marked_at) VALUES(p_job_id,p_reason,clock_timestamp())
 ON CONFLICT(job_id) DO UPDATE SET reason=EXCLUDED.reason,marked_at=clock_timestamp();
END $fn$;

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

CREATE OR REPLACE FUNCTION public.job_profit_refresh(p_job_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
 SELECT public.job_profit_refresh_many(ARRAY[p_job_id]);
$fn$;

CREATE OR REPLACE FUNCTION public.job_profit_refresh_marked(p_limit integer DEFAULT 200) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_ids uuid[]; v_result jsonb; v_left bigint;
/* function block */ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.job_profit_dirty) THEN RETURN '{"refreshed":0,"left":0}'::jsonb; END IF;
 -- job_profit_dirty_oldest_idx serves the bounded oldest-first queue.
 SELECT array_agg(job_id ORDER BY marked_at,job_id) INTO v_ids FROM (
  SELECT job_id,marked_at FROM public.job_profit_dirty ORDER BY marked_at,job_id LIMIT least(greatest(coalesce(p_limit,200),0),500)
 ) s;
 v_result:=public.job_profit_refresh_many(v_ids);
 SELECT count(*) INTO v_left FROM public.job_profit_dirty;
 RETURN jsonb_build_object('refreshed',v_result->'refreshed','left',v_left);
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

CREATE OR REPLACE FUNCTION public.job_profit_stored_compare(p_limit integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_missing jsonb; v_cols text; v_differences jsonb; v_missing_jobs jsonb; v_pair text[]; v_events jsonb; v_jobs bigint;
/* function block */ BEGIN
 -- Diagnostic, explicitly requested only: the view is evaluated once. A limit
 -- scopes comparison, not the work inside the legacy company-wide view.
 CREATE TEMP TABLE job_profit_compare_view ON COMMIT DROP AS
 SELECT * FROM public.v_job_profit ORDER BY job_id LIMIT p_limit;
 SELECT count(*) INTO v_jobs FROM pg_temp.job_profit_compare_view;
 SELECT coalesce(jsonb_agg(a.column_name ORDER BY a.ordinal_position),'[]'::jsonb) INTO v_missing
 FROM information_schema.columns a LEFT JOIN information_schema.columns b ON b.table_schema='public' AND b.table_name='job_profit_stored' AND b.column_name=a.column_name
 WHERE a.table_schema='public' AND a.table_name='v_job_profit' AND b.column_name IS NULL;
 SELECT string_agg(quote_ident(a.column_name),',' ORDER BY a.ordinal_position) INTO v_cols
 FROM information_schema.columns a JOIN information_schema.columns b ON b.table_schema='public' AND b.table_name='job_profit_stored' AND b.column_name=a.column_name
 WHERE a.table_schema='public' AND a.table_name='v_job_profit';
 EXECUTE format($sql$
  SELECT coalesce(jsonb_agg(jsonb_build_object('job_id',v.job_id,'job_number',to_jsonb(v)->'job_number','column',d.key,'stored',to_jsonb(s)->d.key,'view',d.value) ORDER BY v.job_id,d.key COLLATE "C"),'[]'::jsonb)
  FROM pg_temp.job_profit_compare_view v JOIN (SELECT %s FROM public.job_profit_stored) s USING(job_id)
  CROSS JOIN LATERAL jsonb_each(to_jsonb(v)) d
  WHERE d.key IN (SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='job_profit_stored') AND d.value IS DISTINCT FROM to_jsonb(s)->d.key
 $sql$,v_cols) INTO v_differences;
 SELECT coalesce(jsonb_agg(v.job_id ORDER BY v.job_id),'[]'::jsonb) INTO v_missing_jobs
 FROM pg_temp.job_profit_compare_view v LEFT JOIN public.job_profit_stored s USING(job_id) WHERE s.job_id IS NULL;
 -- Stored-only rows are also drift, never silently omitted.
 IF p_limit IS NULL THEN
  SELECT v_differences||coalesce(jsonb_agg(jsonb_build_object('job_id',s.job_id,'job_number',to_jsonb(s)->'job_number','column','job','stored',to_jsonb(s)-'computed_at','view',NULL) ORDER BY s.job_id),'[]'::jsonb) INTO v_differences
  FROM public.job_profit_stored s LEFT JOIN pg_temp.job_profit_compare_view v USING(job_id) WHERE v.job_id IS NULL;
 END IF;
 FOREACH v_pair SLICE 1 IN ARRAY ARRAY[
  ['v_job_cost_events','job_cost_events_stored','cost_events'],
  ['v_job_revenue_events','job_revenue_events_stored','revenue_events']
 ] LOOP
  -- Full aggregates are deliberate diagnostic scans, never a timer. The
  -- stored job_id indexes support the per-job grouping and filtered reads.
  EXECUTE format($sql$
   WITH a AS (SELECT job_id,count(*) n,sum(amount_ex) amount_ex FROM public.%I
    WHERE $1 IS NULL OR job_id IN(SELECT job_id FROM pg_temp.job_profit_compare_view) GROUP BY job_id),
   b AS (SELECT job_id,count(*) n,sum(amount_ex) amount_ex FROM public.%I
    WHERE $1 IS NULL OR job_id IN(SELECT job_id FROM pg_temp.job_profit_compare_view) GROUP BY job_id)
   SELECT coalesce(jsonb_agg(jsonb_build_object('job_id',coalesce(a.job_id,b.job_id),'job_number',v.job_number,'column',%L,
    'stored',jsonb_build_object('count',coalesce(b.n,0),'amount_ex',b.amount_ex),
    'view',jsonb_build_object('count',coalesce(a.n,0),'amount_ex',a.amount_ex)) ORDER BY coalesce(a.job_id,b.job_id)),'[]'::jsonb)
   FROM (SELECT job_id FROM a UNION SELECT job_id FROM b) k
   LEFT JOIN a ON a.job_id IS NOT DISTINCT FROM k.job_id
   LEFT JOIN b ON b.job_id IS NOT DISTINCT FROM k.job_id
   LEFT JOIN pg_temp.job_profit_compare_view v ON v.job_id=coalesce(a.job_id,b.job_id)
   WHERE a.n IS DISTINCT FROM b.n OR a.amount_ex IS DISTINCT FROM b.amount_ex
  $sql$,v_pair[1],v_pair[2],v_pair[3]) INTO v_events USING p_limit;
  v_differences:=v_differences||v_events;
 END LOOP;
 DROP TABLE pg_temp.job_profit_compare_view;
 RETURN jsonb_build_object('jobs',v_jobs,'differences',v_differences,'missing_in_stored',v_missing_jobs,'missing_columns',v_missing);
END $fn$;

REVOKE ALL ON FUNCTION public.job_profit_mark(uuid,text), public.job_profit_refresh_many(uuid[]), public.job_profit_refresh(uuid), public.job_profit_refresh_marked(integer), public.job_profit_refresh_all(), public.job_profit_stored_compare(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit_mark(uuid,text), public.job_profit_refresh_many(uuid[]), public.job_profit_refresh(uuid), public.job_profit_refresh_marked(integer), public.job_profit_refresh_all(), public.job_profit_stored_compare(integer) TO service_role;
