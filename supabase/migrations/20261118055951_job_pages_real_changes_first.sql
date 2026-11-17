-- Follow-up 33: real changes precede explicit bulk marks; bounded page runs.
-- Existing job-page install is live. No trigger, timer or switch is installed here.
-- Pre-images from main also match the director's live-public-object-md5-18nov.tsv.
SET LOCAL lock_timeout='5s';
DO $guard$ DECLARE actual text; /* guard block */ BEGIN
 SELECT md5(prosrc) INTO actual FROM pg_proc WHERE oid='public.job_profit_source_changed(text,jsonb,jsonb,text)'::regprocedure;
 IF actual NOT IN ('0aa6bff34b3470adac9ffdf5719a0de4','b34b1146607493092d07757c21a750ed') THEN
  RAISE EXCEPTION 'fu33_preimage_mismatch: job_profit_source_changed(text,jsonb,jsonb,text) (%)',actual;
 END IF;
 SELECT md5(prosrc) INTO actual FROM pg_proc WHERE oid='public.job_pages_next_due()'::regprocedure;
 IF actual NOT IN ('d35be2589fd0d6009ae964c277eb8ed1','c425381bd8982647f79e7971bc68191a') THEN
  RAISE EXCEPTION 'fu33_preimage_mismatch: job_pages_next_due() (%)',actual;
 END IF;
 SELECT md5(prosrc) INTO actual FROM pg_proc WHERE oid='public.job_pages_refresh_due(integer)'::regprocedure;
 IF actual NOT IN ('24c1f2a21e214ff20c5f6b4d81efc584','244c167fadca40eae9b784c09a855706') THEN
  RAISE EXCEPTION 'fu33_preimage_mismatch: job_pages_refresh_due(integer) (%)',actual;
 END IF;
 SELECT md5(prosrc) INTO actual FROM pg_proc WHERE oid='public.job_profit_refresh_many(uuid[])'::regprocedure;
 IF actual NOT IN ('b82dc4d9fc789fdaafb47eb818a571ca','5bf1ad820296062f851290ae4d750426') THEN
  RAISE EXCEPTION 'fu33_preimage_mismatch: job_profit_refresh_many(uuid[]) (%)',actual;
 END IF;
END $guard$;
-- Main has only time-leading partial due indexes. Neither can supply bulk
-- priority without reading/sorting the queue. These expression indexes provide
-- two ordered LIMIT 1 probes; jobs_pkey validates the event's job.
-- Future bulk writers use source 'bulk'; unknown sources remain real changes.
CREATE INDEX IF NOT EXISTS job_change_mark_events_due_priority
 ON public.job_change_mark_events((source IN ('profit','bulk')),marked_at,job_id) WHERE page_pending;
CREATE INDEX IF NOT EXISTS job_change_marks_base_priority_due
 ON public.job_change_marks_base((cardinality(sources)>0 AND sources <@ ARRAY['profit','bulk']::text[]),first_marked_at,job_id) WHERE page_pending;
CREATE OR REPLACE FUNCTION public.job_profit_source_changed(p_table text,p_old jsonb,p_new jsonb,p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='25ms' AS $fn$
DECLARE row_data jsonb; job_ids uuid[]:='{}'; ids uuid[]; job uuid; tokens text[];
/* block */ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_profit_refresh_v1' AND enabled) THEN RETURN; END IF;
 IF p_old IS NOT NULL AND p_new IS NOT NULL THEN
  IF p_table='xero_invoices' AND p_old-'synced_at'-'updated_at'=p_new-'synced_at'-'updated_at' THEN RETURN; END IF;
  IF p_table<>'jobs' AND p_old=p_new THEN RETURN; END IF;
 END IF;
 FOREACH row_data IN ARRAY ARRAY[p_old,p_new] LOOP
  CONTINUE WHEN row_data IS NULL;
  job_ids:=array_append(job_ids,(row_data->>CASE WHEN p_table='jobs' THEN 'id' ELSE 'job_id' END)::uuid);
  IF p_table='trade_invoices' THEN
   -- idx_inv_lines_invoice (trade_invoice_id). Cascade child deletes also mark
   -- their own OLD.job_id, even after the header is no longer visible.
   SELECT array_agg(DISTINCT l.job_id) INTO ids FROM public.trade_invoice_lines l
    WHERE l.trade_invoice_id=(row_data->>'id')::uuid;
   job_ids:=job_ids||coalesce(ids,'{}');
  ELSIF p_table='group_work_order_shares' THEN
   -- group_work_orders_pkey. Parent deletes/relinks have their own trigger.
   SELECT ARRAY[g.job_id] INTO ids FROM public.group_work_orders g WHERE g.id=(row_data->>'group_id')::uuid;
   job_ids:=job_ids||coalesce(ids,'{}');
  ELSIF p_table='xero_supplier_credit_note_allocations' THEN
   -- xero_invoices_xero_invoice_id_idx, job_materials_facts_invoice_idx.
   SELECT array_agg(job_id) INTO ids FROM (
    SELECT x.job_id FROM public.xero_invoices x WHERE x.xero_invoice_id=row_data->>'xero_invoice_id'
    UNION SELECT f.job_id FROM public.job_materials_facts f WHERE f.xero_invoice_id=row_data->>'xero_invoice_id'
   ) linked;
   job_ids:=job_ids||coalesce(ids,'{}');
  ELSIF p_table='xero_invoices' THEN
   SELECT array_agg(DISTINCT upper(m[1])) INTO tokens FROM regexp_matches(
    coalesce(row_data->>'reference','')||' '||coalesce(row_data->>'invoice_number','')||' '||coalesce(row_data->>'line_items',''),
    '(SW[A-Z]{0,5}-[0-9]{3,6})','gi') m;
   -- jobs_context_job_number_upper, exact token lookup, never a scan per job.
   SELECT array_agg(j.id) INTO ids FROM public.jobs j WHERE upper(j.job_number)=ANY(tokens);
   job_ids:=job_ids||coalesce(ids,'{}');
  END IF;
 END LOOP;
 FOR job IN SELECT DISTINCT j FROM unnest(job_ids) j WHERE j IS NOT NULL ORDER BY j LOOP
  INSERT INTO public.job_profit_change_events(job_id,reason) VALUES(job,p_reason);
  -- Source changes dirty the profit store only. The refresh marks the page
  -- once, with bulk source 'profit', only after its figures actually changed.
 END LOOP;
EXCEPTION WHEN OTHERS THEN
 -- Failed marks never fail a business write. The whole helper subtransaction
 -- rolls back, and the daily sweep is the recovery net. No row content is logged.
 RAISE WARNING 'job_profit_source_mark_failed table=% code=%',p_table,SQLSTATE;
END $fn$;
CREATE OR REPLACE FUNCTION public.job_pages_next_due() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $due$
 SELECT q.job_id FROM (
  (SELECT e.job_id,e.marked_at AS first_at,(e.source IN ('profit','bulk')) AS bulk
   FROM public.job_change_mark_events e
   WHERE e.page_pending AND EXISTS(SELECT 1 FROM public.jobs j WHERE j.id=e.job_id)
   ORDER BY (e.source IN ('profit','bulk')),e.marked_at,e.job_id LIMIT 1)
  UNION ALL
  (SELECT b.job_id,b.first_marked_at,
    (cardinality(b.sources)>0 AND b.sources <@ ARRAY['profit','bulk']::text[]) AS bulk
   FROM public.job_change_marks_base b WHERE b.page_pending
   ORDER BY (cardinality(b.sources)>0 AND b.sources <@ ARRAY['profit','bulk']::text[]),
    b.first_marked_at,b.job_id LIMIT 1)
 ) q ORDER BY q.bulk,q.first_at,q.job_id LIMIT 1
$due$;
CREATE OR REPLACE FUNCTION public.job_pages_refresh_due(p_limit integer DEFAULT 5) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_id uuid; v_result jsonb; v_left bigint; v_refreshed integer:=0; v_failed integer:=0;
 v_start timestamptz:=clock_timestamp(); v_attempts integer:=0; v_seen uuid[]:='{}'; v_capped boolean;
/* queue block */ BEGIN
 IF NOT pg_try_advisory_xact_lock(20261118,1) THEN RETURN '{"outcome":"busy"}'::jsonb; END IF;
 -- A run attempts at most p_limit jobs (ceiling 100), and starts none after 40s.
 -- The existing page builder catches a timed-out build and retains its retry turn.
 WHILE v_attempts<greatest(0,least(coalesce(p_limit,1),100))
  AND clock_timestamp()-v_start<interval '40 seconds'
 LOOP
  /* pick block */ BEGIN
   v_id:=public.job_pages_next_due();
  EXCEPTION WHEN query_canceled THEN
   RETURN jsonb_build_object('outcome','timed_out','refreshed',v_refreshed,'failed',v_failed,'left',NULL);
  END;
  EXIT WHEN v_id IS NULL OR v_id=ANY(v_seen) OR clock_timestamp()-v_start>=interval '40 seconds';
  v_seen:=array_append(v_seen,v_id);
  v_attempts:=v_attempts+1;
  v_result:=public.job_page_refresh(v_id);
  IF v_result->>'outcome'='built' THEN v_refreshed:=v_refreshed+1; END IF;
  IF v_result->>'outcome'='failed' THEN v_failed:=v_failed+1; END IF;
 END LOOP;
 -- Count a bounded sample, not the entire queue: at most 1001 marks from each
 -- existing due index, followed by at most 2002 job ids to deduplicate.
 -- If sampled ids repeat, left is a lower bound; left_capped says so explicitly.
 /* count block */ BEGIN
  WITH events AS MATERIALIZED (
   SELECT e.job_id FROM public.job_change_mark_events e WHERE e.page_pending
    ORDER BY e.marked_at,e.job_id LIMIT 1001
  ), base AS MATERIALIZED (
   SELECT b.job_id FROM public.job_change_marks_base b WHERE b.page_pending
    ORDER BY b.first_marked_at,b.job_id LIMIT 1001
  ), due AS (
   SELECT e.job_id FROM events e
    WHERE (SELECT j.id FROM public.jobs j WHERE j.id=e.job_id LIMIT 1) IS NOT NULL
   UNION SELECT b.job_id FROM base b
  )
  SELECT least(count(*),1000),
   (SELECT count(*) FROM events)=1001 OR (SELECT count(*) FROM base)=1001 OR count(*)>1000
  INTO v_left,v_capped FROM due;
 EXCEPTION WHEN query_canceled THEN v_left:=NULL; v_capped:=true;
 END;
 RETURN jsonb_build_object('outcome','ran','refreshed',v_refreshed,'failed',v_failed,
  'left',v_left,'left_capped',v_capped);
END $fn$;
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
 -- Explicit refill-only option. SET LOCAL confines suppression to this batch transaction.
 -- Dirty-row clearing, stored figures and change counts are identical on both paths.
 IF current_setting('secureworks.job_profit_no_page_mark',true) IS DISTINCT FROM 'on'
  AND to_regprocedure('public.job_mark_changed(uuid,text)') IS NOT NULL AND v_changed IS NOT NULL THEN
  FOREACH v_id IN ARRAY v_changed LOOP
   EXECUTE 'SELECT public.job_mark_changed($1,$2)' USING v_id,'profit';
  END LOOP;
 END IF;
 DROP TABLE pg_temp.job_profit_refresh_before,pg_temp.job_profit_refresh_cost,pg_temp.job_profit_refresh_revenue,pg_temp.job_profit_refresh_profit;
 RETURN jsonb_build_object('refreshed',v_refreshed,'changed',coalesce(cardinality(v_changed),0),'ms',extract(epoch FROM clock_timestamp()-v_start)*1000);
END $fn$;
