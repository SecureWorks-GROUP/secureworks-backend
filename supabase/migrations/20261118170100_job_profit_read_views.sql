-- P0-09.5. The Job Profit and story switches are independent. The story's
-- arm, fingerprint and change-mark decision is authoritative for both.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $new_helpers$
/* function block */ BEGIN
 IF EXISTS (SELECT 1 FROM (VALUES
   ('public.job_profit_read_on()','6dcb9994f2d303c40694850653fafe74'),
   ('public.job_profit_read_as_at(uuid)','e9bc6a4efb109efedff625486e458373'),
   ('public.job_profit_page_card_for_text(uuid,jsonb)','8bb2fcfb24d12ddc2d75894578b6e135')
  ) want(sig,hash) JOIN pg_proc p ON p.oid=to_regprocedure(want.sig) WHERE md5(p.prosrc)<>want.hash) THEN
  RAISE EXCEPTION 'job_profit_read_helper_preimage';
 END IF;
END $new_helpers$;

CREATE OR REPLACE FUNCTION public.job_profit_read_on() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
/* function block */ BEGIN
 RETURN EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'job_profit_stored_read_v1' AND enabled);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $fn$;

CREATE OR REPLACE FUNCTION public.job_profit_read_as_at(p_job_id uuid) RETURNS timestamptz
LANGUAGE plpgsql STABLE STRICT SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
/* function block */ BEGIN
 RETURN public.job_story_stored_profit_as_at(p_job_id, now());
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $fn$;

REVOKE ALL ON FUNCTION public.job_profit_read_on(), public.job_profit_read_as_at(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit_read_on(), public.job_profit_read_as_at(uuid) TO service_role;

-- Enumerate the actual columns by name at definition time, in the store's
-- order. The read views carry exactly the live view's columns plus
-- computed_at. A column only the store has (the proven-share columns of
-- 20261118124326) is not a live figure and is left out, so a live row and a
-- stored row have the same keys. A live column the store lacks, or holds in
-- another type, refuses: never omit a figure.
DO $views$
DECLARE
 stem text; live_rel regclass; stored_rel regclass; view_name text;
 live_cols text; keyed_stored_cols text; keyed_live_cols text; population text; col_types text; body_sql text; helper text;
/* function block */ BEGIN
 FOREACH stem IN ARRAY ARRAY['job_profit','job_cost_events','job_revenue_events'] LOOP
  live_rel := format('public.v_%s',stem)::regclass;
  stored_rel := format('public.%s_stored',stem)::regclass;
  view_name := format('v_%s_read',stem);
  IF EXISTS (
   SELECT 1 FROM (SELECT attname,atttypid,atttypmod FROM pg_attribute
     WHERE attrelid=live_rel AND attnum>0 AND NOT attisdropped) l
   LEFT JOIN (SELECT attname,atttypid,atttypmod FROM pg_attribute
     WHERE attrelid=stored_rel AND attnum>0 AND NOT attisdropped) s USING(attname)
   WHERE l.attname='computed_at' OR l.atttypid IS DISTINCT FROM s.atttypid OR l.atttypmod IS DISTINCT FROM s.atttypmod
  ) OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=stored_rel AND attname='computed_at'
     AND atttypid='timestamptz'::regtype AND NOT attisdropped)
  THEN RAISE EXCEPTION 'job_profit_read_schema_mismatch: %',stem; END IF;
  SELECT string_agg(CASE WHEN attname='computed_at' THEN 'NULL::timestamptz AS computed_at' ELSE format('v.%I',attname) END, ', ' ORDER BY attnum),
         string_agg(CASE WHEN attname='job_id' THEN 'j.id AS job_id' ELSE format('s.%I',attname) END, ', ' ORDER BY attnum),
         string_agg(CASE attname WHEN 'job_id' THEN 'j.id AS job_id' WHEN 'computed_at' THEN 'NULL::timestamptz AS computed_at'
           ELSE format('v.%I',attname) END, ', ' ORDER BY attnum)
  , string_agg(format('%I %s',attname,pg_catalog.format_type(atttypid,atttypmod)), ', ' ORDER BY attnum)
  INTO live_cols,keyed_stored_cols,keyed_live_cols,col_types
  FROM pg_attribute WHERE attrelid=stored_rel AND attnum>0 AND NOT attisdropped
   AND (attname='computed_at' OR attname IN (SELECT a.attname FROM pg_attribute a
     WHERE a.attrelid=live_rel AND a.attnum>0 AND NOT a.attisdropped));
  -- Only profit summaries exclude legacy jobs. Their event rows remain readable.
  population := CASE WHEN stem='job_profit' THEN ' AND j.legacy IS NOT TRUE' ELSE '' END;
  -- Drive the keyed route from jobs.id so a detail read can reject the
  -- entire live branch before executing it. The list fallback is a set join:
  -- the existing live view can calculate many stale jobs together.
  body_sql := format($view$
   WITH mode AS MATERIALIZED (SELECT public.job_profit_read_on() AS enabled)
   SELECT %s FROM %s v WHERE NOT (SELECT enabled FROM mode)
   UNION ALL
   SELECT %s FROM public.jobs j JOIN %s s ON s.job_id=j.id
    WHERE (SELECT enabled FROM mode)%s AND public.job_profit_read_as_at(j.id) IS NOT NULL
   UNION ALL
   SELECT %s FROM public.jobs j JOIN %s v ON v.job_id=j.id
    WHERE (SELECT enabled FROM mode)%s AND public.job_profit_read_as_at(j.id) IS NULL
  $view$, live_cols,'public.v_'||stem,keyed_stored_cols,'public.'||stem||'_stored',population,
   keyed_live_cols,'public.v_'||stem,population);
  -- The existing migration chain drops and recreates the live views to
  -- remove appended columns on rollback. An inlinable SQL table function
  -- preserves predicate pushdown without taking a dependency on those OIDs.
  helper := stem||'_read_rows';
  IF to_regprocedure(format('public.%I()',helper)) IS NOT NULL AND
    (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(format('public.%I()',helper))) <> md5(body_sql) THEN
   RAISE EXCEPTION 'job_profit_read_preimage: %',helper;
  END IF;
  EXECUTE format('CREATE OR REPLACE FUNCTION public.%I() RETURNS TABLE (%s) LANGUAGE sql STABLE SECURITY INVOKER AS %L',helper,col_types,body_sql);
  EXECUTE format('REVOKE ALL ON FUNCTION public.%I() FROM PUBLIC, anon, authenticated',helper);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I() TO service_role',helper);
  EXECUTE format('CREATE OR REPLACE VIEW public.%I AS SELECT * FROM public.%I()',view_name,helper);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated, service_role',view_name);
  EXECUTE format('GRANT SELECT ON public.%I TO service_role',view_name);
 END LOOP;
END $views$;

-- Keep the batch evidence rule, including live accounting evidence, as the
-- source of both answers. Only the three profit relations change on a fresh
-- single-job read. The original batch and its scorecard callers stay intact.
DO $evidence$
DECLARE canonical text; stored text;
/* function block */ BEGIN
 canonical := pg_get_functiondef('public.job_profit_line_evidence_many(uuid[])'::regprocedure);
 IF md5(canonical) <> 'b9114d87ccc74b6171bbb51d92be69b4' THEN
  RAISE EXCEPTION 'job_profit_read_evidence_preimage';
 END IF;
 stored := replace(canonical,'FUNCTION public.job_profit_line_evidence_many(','FUNCTION public.job_profit_read_stored_evidence(');
 stored := replace(stored,'FROM public.v_job_profit p','FROM public.job_profit_stored p');
 stored := replace(stored,'FROM public.v_job_cost_events c','FROM public.job_cost_events_stored c');
 stored := replace(stored,'FROM public.v_job_revenue_events e','FROM public.job_revenue_events_stored e');
 IF to_regprocedure('public.job_profit_read_stored_evidence(uuid[])') IS NOT NULL AND
    pg_get_functiondef(to_regprocedure('public.job_profit_read_stored_evidence(uuid[])')) <> stored THEN
  RAISE EXCEPTION 'job_profit_read_stored_evidence_preimage';
 END IF;
 EXECUTE stored;
END $evidence$;
REVOKE ALL ON FUNCTION public.job_profit_read_stored_evidence(uuid[]) FROM PUBLIC,anon,authenticated;
-- Only the definer of the single-job reader uses the stored implementation.
REVOKE ALL ON FUNCTION public.job_profit_read_stored_evidence(uuid[]) FROM service_role;

DO $guard$
/* function block */ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.job_profit_line_evidence(uuid)'::regprocedure)
    NOT IN ('e07cf775a74cda10cca2e40d4bafc540','07898420ba1e0119b410b4e1447bd3fa') THEN RAISE EXCEPTION 'job_profit_read_single_evidence_preimage'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.job_profit_line_evidence(p_job_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $one$
DECLARE evidence jsonb;
/* function block */ BEGIN
 IF public.job_profit_read_on() AND public.job_profit_read_as_at(p_job_id) IS NOT NULL THEN
  /* Keep a later change to the main evidence rule authoritative. */
  IF md5(pg_get_functiondef('public.job_profit_line_evidence_many(uuid[])'::regprocedure))='b9114d87ccc74b6171bbb51d92be69b4' THEN
   /* stored read */ BEGIN
    SELECT result INTO STRICT evidence FROM public.job_profit_read_stored_evidence(ARRAY[p_job_id]);
    RETURN evidence;
   EXCEPTION WHEN OTHERS THEN NULL;
   END;
  END IF;
 END IF;
 RETURN (SELECT result FROM public.job_profit_line_evidence_many(ARRAY[p_job_id]));
END $one$;

-- Only the cold, staff-initiated page build takes this path. A cache hit
-- does not read profit. The saved card and the scheduled builder keep their
-- payloads. Supply the book only to the existing story text reader.
CREATE OR REPLACE FUNCTION public.job_profit_page_card_for_text(j uuid, card jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $card$
DECLARE book jsonb;
/* function block */ BEGIN
 IF card IS NULL OR public.job_story_stored_profit_on() OR public.job_profit_read_as_at(j) IS NULL THEN RETURN card; END IF;
 book := public.context_job_story_book_stored(j,now());
 IF book->>'job_id'=j::text THEN RETURN card||jsonb_build_object('book',book); END IF;
 RETURN card;
EXCEPTION WHEN OTHERS THEN RETURN card;
END $card$;
REVOKE ALL ON FUNCTION public.job_profit_page_card_for_text(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Keep the exact page lock, mark tracking, write and retry semantics. Only
-- the text reader's input differs. Never invoke the derived build after its
-- source has changed. The existing timer always uses the original builder.
DO $page$
DECLARE d text; switched text;
/* function block */ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.job_page_refresh(uuid)'::regprocedure)
   IS DISTINCT FROM '7c10bf73a85170c37f9a88051cb5ce47' THEN RAISE EXCEPTION 'job_profit_read_page_refresh_preimage'; END IF;
 d:=pg_get_functiondef('public.job_page_refresh(uuid)'::regprocedure);
 switched:=replace(replace(d,'FUNCTION public.job_page_refresh(','FUNCTION public.job_profit_page_refresh('),
   'context_job_story_text_get(p_job_id, v_card, true)','context_job_story_text_get(p_job_id, public.job_profit_page_card_for_text(p_job_id,v_card), true)');
 IF to_regprocedure('public.job_profit_page_refresh(uuid)') IS NOT NULL AND
   pg_get_functiondef(to_regprocedure('public.job_profit_page_refresh(uuid)'))<>switched THEN
  RAISE EXCEPTION 'job_profit_read_page_copy_preimage';
 END IF;
 EXECUTE switched;
END $page$;
REVOKE ALL ON FUNCTION public.job_profit_page_refresh(uuid) FROM PUBLIC,anon,authenticated,service_role;
DO $page_guard$
/* function block */ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.job_page_get(uuid)'::regprocedure) NOT IN ('4fad727218d2eda48113c658512f86b9','e63a7bd0a521e83c5f57f3d51da85129')
  THEN RAISE EXCEPTION 'job_profit_read_page_get_preimage'; END IF;
END $page_guard$;
CREATE OR REPLACE FUNCTION public.job_page_get(p_job_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE p public.job_pages;
/* function block */ BEGIN
 SELECT * INTO p FROM public.job_pages WHERE job_id=p_job_id;
 IF NOT FOUND THEN
  IF public.job_profit_read_on() AND (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.job_page_refresh(uuid)'::regprocedure)
     ='7c10bf73a85170c37f9a88051cb5ce47' THEN
   PERFORM public.job_profit_page_refresh(p_job_id);
  ELSE
   PERFORM public.job_page_refresh(p_job_id);
  END IF;
  UPDATE public.job_pages SET kept_ready=false WHERE job_id=p_job_id;
  SELECT * INTO p FROM public.job_pages WHERE job_id=p_job_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
 END IF;
 RETURN p.page || jsonb_build_object('as_at',p.built_at,'status',p.status,'kept_ready',p.kept_ready,
  'page_version',p.page_version,'stale',EXISTS (SELECT 1 FROM public.job_change_marks m
   WHERE m.job_id=p_job_id AND m.mark_version IS DISTINCT FROM p.covers_mark_version));
END $fn$;
