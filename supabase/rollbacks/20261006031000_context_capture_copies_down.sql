-- Down migration for 20261006031000_context_capture_copies.
--
-- Restores context_event_source_admissible to 20261002170000's body and
-- capture_ghl_history_event to M4's (20260925031500), each md5 checked at the
-- end, and drops context_ghl_message_copies. After it, a row marked as a copy
-- (metadata.duplicate_of) is read again like any other row, and the GHL
-- history load saves a message another writer already saved. No
-- business_events row is touched: undo the marking first with
-- scripts/context-dedupe-copies-undo.sql if the marks should go too. Refuses
-- when a replaced function is neither this migration's body nor the restored
-- one (a later migration owns it now: roll that back first).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_event_source_admissible(public.business_events)',ARRAY['09efe91e52fd78c868a7a387bd10fff5','fefd29131583c8e2afef18eca885b4d7']),
  ('public.capture_ghl_history_event(jsonb)',ARRAY['1411b79a4389048ba5de109fe6701e94','3e51278532e7c92a64b0cc9935ce2652'])
 ) AS t(sig,accepted) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_capture_copies_rollback_mismatch: %; a later migration replaced these, roll it back first',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 20261002170000's admission rule.
CREATE OR REPLACE FUNCTION public.context_event_source_admissible(e public.business_events) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT coalesce(
  e.job_id IS NOT NULL
  AND e.attribution_status IS NOT NULL AND public.context_linked_status(e.attribution_status)
  AND (e.payload OPERATOR(pg_catalog.#>>) '{job_id}'::pg_catalog.text[] IS NULL
   OR e.payload OPERATOR(pg_catalog.#>>) '{job_id}'::pg_catalog.text[] OPERATOR(pg_catalog.=) e.job_id::pg_catalog.text)
  AND coalesce(e.event_at,e.occurred_at) IS NOT NULL
  AND e.attribution_confidence IS NOT NULL
  AND e.attribution_confidence OPERATOR(pg_catalog.>=) 0 AND e.attribution_confidence OPERATOR(pg_catalog.<=) 1
  AND e.metadata OPERATOR(pg_catalog.#>>) '{retracted_at}'::pg_catalog.text[] IS NULL
  AND (e.metadata OPERATOR(pg_catalog.#>>) '{retracted}'::pg_catalog.text[] IS NULL
   OR e.metadata OPERATOR(pg_catalog.#>>) '{retracted}'::pg_catalog.text[] OPERATOR(pg_catalog.<>) 'true'),
 false)
$$;
COMMENT ON FUNCTION public.context_event_source_admissible(public.business_events) IS
 'True when persist_luna_context_revision would accept this row as a source for its own job: linked status, payload.job_id absent or equal to job_id (exact text), a source time, an attribution confidence in [0,1], not retracted in metadata. The one admission rule both batch readers apply (20261002170000). Service role only.';

-- M4's history door (20260925031500).
CREATE OR REPLACE FUNCTION public.capture_ghl_history_event(p_row jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pol jsonb:=public.context_ghl_history_policy();
BEGIN
 IF p_row IS NULL OR jsonb_typeof(p_row)<>'object' THEN RETURN jsonb_build_object('outcome','error','code','capture_row_invalid'); END IF;
 IF jsonb_typeof(p_row->'metadata')<>'object' OR p_row->'metadata'->>'capture_mode' IS DISTINCT FROM 'backfill' THEN
  RETURN jsonb_build_object('outcome','error','code','history_row_not_backfill');
 END IF;
 IF p_row->>'source' IS DISTINCT FROM pol->>'event_source' THEN RETURN jsonb_build_object('outcome','error','code','history_row_source_invalid'); END IF;
 -- A history row never asserts a job: the ladder decides, and the writer's
 -- upgrade rule (a verified direct job id) can never fire from this door.
 IF nullif(p_row->>'job_id','') IS NOT NULL OR coalesce(nullif(p_row->>'match_method',''),'none')<>'none' THEN
  RETURN jsonb_build_object('outcome','error','code','history_row_job_refused');
 END IF;
 -- With the attribution lane off the ladder places nothing; history is loaded
 -- only while it is on, so every row is placed at its own time on insert.
 IF NOT public.automation_lane_enabled('attribution') THEN RETURN jsonb_build_object('outcome','error','code','attribution_disabled'); END IF;
 RETURN public.capture_business_event(p_row);
END $$;
COMMENT ON FUNCTION public.capture_ghl_history_event(jsonb) IS
 'M4: the GHL history load''s only writer. Accepts only a capture_mode backfill row from source ghl-history-load that names no job, only while the attribution lane is on, and saves it through capture_business_event; the placement-owned trigger places it. Writes no placement field. Returns the writer''s outcome.';

DROP FUNCTION IF EXISTS public.context_ghl_message_copies(jsonb);

REVOKE ALL ON FUNCTION public.context_event_source_admissible(public.business_events),public.capture_ghl_history_event(jsonb)
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_event_source_admissible(public.business_events),public.capture_ghl_history_event(jsonb)
TO service_role;

DO $$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_event_source_admissible(public.business_events)','fefd29131583c8e2afef18eca885b4d7'),
  ('public.capture_ghl_history_event(jsonb)','3e51278532e7c92a64b0cc9935ce2652')
 ) AS t(sig,want) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.want THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 IF to_regprocedure('public.context_ghl_message_copies(jsonb)') IS NOT NULL THEN problems:=problems||'context_ghl_message_copies(jsonb) still exists'::text; END IF;
 IF cardinality(problems)>0 THEN RAISE EXCEPTION 'context_capture_copies rollback: bodies not restored: %',array_to_string(problems,'; '); END IF;
END $$;
