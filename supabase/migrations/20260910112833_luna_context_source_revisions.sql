-- Source-revision custody for the Luna writer. No source bodies are copied here.
-- Generated filename manually: local CLI telemetry attempted an unavailable home write.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE public.luna_context_source_revisions (
  source_table text NOT NULL CHECK (source_table IN ('business_events','inbox_events','job_events')),
  source_id uuid NOT NULL,
  source_revision_sha256 text NOT NULL CHECK (source_revision_sha256 ~ '^[a-f0-9]{64}$'),
  lifecycle text NOT NULL CHECK (lifecycle IN ('active','superseded','retracted')),
  fact_store text CHECK (fact_store IN ('job_context','job_temporary_context')),
  fact_id uuid,
  fact_sha256 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_table, source_id, source_revision_sha256),
  CHECK ((fact_store IS NULL AND fact_id IS NULL AND fact_sha256 IS NULL)
      OR (fact_store IS NOT NULL AND fact_id IS NOT NULL AND fact_sha256 IS NOT NULL AND fact_sha256 ~ '^[a-f0-9]{64}$'))
);
ALTER TABLE public.luna_context_source_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.luna_context_source_revisions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.luna_context_source_revisions TO service_role;
CREATE POLICY service_role_all_luna_revisions ON public.luna_context_source_revisions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.persist_luna_context_revision(
  p_source_table text, p_source_id text, p_expected_source jsonb,
  p_store text, p_fact jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog
AS $function$
DECLARE
  source_uuid uuid;
  source_row jsonb;
  revision text;
  prior public.luna_context_source_revisions%ROWTYPE;
  fact_uuid uuid;
  existing jsonb;
  existing_store text;
  candidate jsonb;
  target text;
  inserted_fact jsonb;
  fact_hash text;
  at_time timestamptz := clock_timestamp();
  refs jsonb;
  binding_contact_id text;
  direct_binding boolean;
  extractor constant text := 'context-luna-subscription:v1';
  retract boolean := p_fact IS NULL OR p_fact = 'null'::jsonb;
BEGIN
  IF p_source_table IS NULL OR p_source_table NOT IN ('business_events','inbox_events','job_events')
     OR p_source_id IS NULL OR jsonb_typeof(p_expected_source) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'luna_source_identity_invalid';
  END IF;
  BEGIN source_uuid := p_source_id::uuid;
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'luna_source_identity_invalid'; END;

  -- This row lock serializes the two fact stores, retractions and every worker
  -- for this source. At READ COMMITTED a waiting SELECT sees the updated row.
  EXECUTE format('SELECT to_jsonb(s) FROM public.%I s WHERE id = $1 FOR UPDATE', p_source_table)
    INTO source_row USING source_uuid;
  IF source_row IS NULL THEN RAISE EXCEPTION 'luna_source_missing'; END IF;
  IF source_row IS DISTINCT FROM p_expected_source THEN RAISE EXCEPTION 'luna_source_revision_stale'; END IF;
  revision := encode(sha256(convert_to(source_row::text, 'UTF8')), 'hex');
  refs := jsonb_build_array(jsonb_build_object('table', p_source_table, 'id', source_uuid::text));

  IF retract THEN
    IF p_store IS NOT NULL THEN RAISE EXCEPTION 'luna_fact_store_invalid'; END IF;
  ELSE
    IF p_store IS NULL OR p_store NOT IN ('job_context','job_temporary_context')
       OR jsonb_typeof(p_fact) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'luna_fact_store_invalid'; END IF;
    BEGIN fact_uuid := (p_fact->>'id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'luna_fact_identity_invalid'; END;
    IF fact_uuid IS NULL OR source_row->>'job_id' IS NULL
       OR p_fact->>'job_id' IS DISTINCT FROM source_row->>'job_id'
       OR (source_row#>>'{payload,job_id}' IS NOT NULL AND source_row#>>'{payload,job_id}' IS DISTINCT FROM source_row->>'job_id')
       OR (source_row#>>'{detail_json,job_id}' IS NOT NULL AND source_row#>>'{detail_json,job_id}' IS DISTINCT FROM source_row->>'job_id')
       OR p_fact#>'{value,source_refs}' IS DISTINCT FROM refs
       OR p_fact#>>'{provenance,extractor}' IS DISTINCT FROM extractor
       OR p_fact#>'{provenance,source_event_ids}' IS DISTINCT FROM jsonb_build_array(source_uuid::text)
       OR p_fact#>>'{provenance,writer_role}' IS DISTINCT FROM 'classifier'
       OR p_fact#>'{provenance,untrusted}' IS DISTINCT FROM 'false'::jsonb
       OR p_fact#>'{provenance,safety}' IS DISTINCT FROM '{"memory_trusted":true,"action_safe":false,"state_change_safe":false,"outbound_safe":false}'::jsonb
       OR (p_fact#>>'{provenance,lifecycle}' IS NOT NULL AND p_fact#>>'{provenance,lifecycle}' <> 'active')
    THEN RAISE EXCEPTION 'luna_fact_source_mismatch'; END IF;
    -- Explicit source revocation outranks a plausible job link. Retraction is
    -- permitted for these rows, insertion is not.
    IF (source_row->>'match_status' IS NOT NULL AND source_row->>'match_status' <> 'matched')
       OR (source_row#>>'{metadata,match_status}' IS NOT NULL AND source_row#>>'{metadata,match_status}' <> 'matched')
       OR source_row->>'retracted_at' IS NOT NULL OR source_row#>>'{metadata,retracted_at}' IS NOT NULL
       OR source_row->>'retracted' = 'true' OR source_row#>>'{metadata,retracted}' = 'true'
    THEN RAISE EXCEPTION 'luna_source_attribution_rejected'; END IF;
    direct_binding := p_source_table = 'job_events'
      OR (p_source_table = 'business_events' AND source_row->>'match_status' = 'matched'
        AND source_row->>'match_method' IN ('direct_job_id','direct_reference','manual'))
      OR (p_source_table = 'inbox_events' AND source_row#>>'{metadata,match_confidence}' = 'high'
        AND source_row#>>'{metadata,matched_via}' ~ '^(ai_po|ai_quote|ai_inv_via_po|ai_inv_via_job|ai_job_ref|legacy_sw|job_ref|po):.+$');
    IF NOT coalesce(direct_binding, false) THEN
      binding_contact_id := CASE WHEN p_source_table = 'business_events' THEN source_row->>'contact_id'
        ELSE source_row->>'ghl_contact_id' END;
      IF binding_contact_id IS NULL OR btrim(binding_contact_id) = '' OR NOT coalesce(
        (p_source_table = 'business_events' AND source_row->>'match_status' = 'matched'
          AND source_row->>'match_method' IN ('contact_id','email_match','phone_match','single_recent_active_job'))
        OR (p_source_table = 'inbox_events' AND source_row#>>'{metadata,match_confidence}' = 'high'
          AND source_row#>>'{metadata,matched_via}' ~ '^client_email:.+$'), false)
      THEN RAISE EXCEPTION 'luna_source_attribution_unproven'; END IF;
      IF EXISTS (SELECT 1 FROM public.jobs j WHERE j.ghl_contact_id = binding_contact_id AND j.id <> (source_row->>'job_id')::uuid)
        OR EXISTS (SELECT 1 FROM public.contact_matches m WHERE m.ghl_contact_id = binding_contact_id AND m.job_id <> (source_row->>'job_id')::uuid)
      THEN RAISE EXCEPTION 'luna_source_attribution_ambiguous'; END IF;
      IF NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.ghl_contact_id = binding_contact_id AND j.id = (source_row->>'job_id')::uuid)
        AND NOT EXISTS (SELECT 1 FROM public.contact_matches m WHERE m.ghl_contact_id = binding_contact_id AND m.job_id = (source_row->>'job_id')::uuid)
      THEN RAISE EXCEPTION 'luna_source_attribution_unproven'; END IF;
    END IF;
  END IF;

  SELECT * INTO prior FROM public.luna_context_source_revisions
    WHERE source_table = p_source_table AND source_id = source_uuid AND source_revision_sha256 = revision;
  IF FOUND AND NOT (prior.lifecycle = 'active' AND retract) THEN
    IF prior.lifecycle = 'retracted' AND retract THEN
      RETURN jsonb_build_object('fact_id', NULL, 'outcome', 'retracted');
    END IF;
    IF prior.lifecycle <> 'active' OR retract OR prior.fact_store IS DISTINCT FROM p_store
       OR prior.fact_id IS DISTINCT FROM fact_uuid THEN
      RETURN jsonb_build_object('fact_id', prior.fact_id, 'outcome', 'held');
    END IF;
    EXECUTE format('SELECT to_jsonb(f) FROM public.%I f WHERE id = $1 FOR UPDATE', prior.fact_store)
      INTO existing USING prior.fact_id;
    fact_hash := encode(sha256(convert_to((existing - ARRAY['created_at','updated_at'])::text,'UTF8')),'hex');
    IF existing IS NULL OR fact_hash IS DISTINCT FROM prior.fact_sha256
       OR existing#>'{provenance,safety,memory_trusted}' IS DISTINCT FROM 'true'::jsonb
       OR coalesce(existing#>>'{provenance,lifecycle}','active') <> 'active' THEN
      RETURN jsonb_build_object('fact_id', prior.fact_id, 'outcome', 'held');
    END IF;
    RETURN jsonb_build_object('fact_id', prior.fact_id, 'outcome', 'idempotent');
  END IF;

  IF NOT retract THEN
    -- Never overwrite a stable-ID collision, human edit, or a retired row.
    -- A matching pre-RPC Luna row can be adopted byte-for-byte into the ledger.
    FOREACH target IN ARRAY ARRAY['job_context','job_temporary_context'] LOOP
      EXECUTE format('SELECT to_jsonb(f) FROM public.%I f WHERE id = $1 FOR UPDATE', target)
        INTO candidate USING fact_uuid;
      IF candidate IS NOT NULL THEN
        IF existing IS NOT NULL OR target <> p_store THEN
          RETURN jsonb_build_object('fact_id', fact_uuid, 'outcome', 'held');
        END IF;
        existing := candidate;
        existing_store := target;
      END IF;
    END LOOP;
    IF existing IS NOT NULL THEN
      IF existing->>'job_id' IS DISTINCT FROM p_fact->>'job_id'
         OR existing->>'kind' IS DISTINCT FROM p_fact->>'kind'
         OR existing->'value' IS DISTINCT FROM p_fact->'value'
         OR existing->'correlation_id' IS DISTINCT FROM coalesce(p_fact->'correlation_id','null'::jsonb)
         OR (p_store = 'job_temporary_context' AND (existing->>'expires_at')::timestamptz IS DISTINCT FROM (p_fact->>'expires_at')::timestamptz)
         OR ((existing->'provenance') - ARRAY['extracted_at','usage']) IS DISTINCT FROM ((p_fact->'provenance') - ARRAY['extracted_at','usage'])
         OR existing#>'{provenance,safety,memory_trusted}' IS DISTINCT FROM 'true'::jsonb
         OR coalesce(existing#>>'{provenance,lifecycle}','active') <> 'active'
      THEN RETURN jsonb_build_object('fact_id', fact_uuid, 'outcome', 'held'); END IF;
      inserted_fact := existing;
    ELSE
      -- Explicit column allowlist: callers cannot assign creation clocks or other
      -- table columns through jsonb_populate_record. Source digest is server-made.
      candidate := jsonb_set(p_fact, '{provenance}', (p_fact->'provenance') || jsonb_build_object(
        'source_revision_sha256', revision, 'source_table', p_source_table,
        'source_id', source_uuid::text, 'lifecycle', 'active'));
      IF p_store = 'job_context' THEN
        INSERT INTO public.job_context (id,job_id,kind,value,provenance,correlation_id)
          VALUES (fact_uuid,(candidate->>'job_id')::uuid,candidate->>'kind',candidate->'value',candidate->'provenance',
            (candidate->>'correlation_id')::uuid)
          RETURNING to_jsonb(job_context) INTO inserted_fact;
      ELSE
        INSERT INTO public.job_temporary_context (id,job_id,kind,value,provenance,correlation_id,expires_at)
          VALUES (fact_uuid,(candidate->>'job_id')::uuid,candidate->>'kind',candidate->'value',candidate->'provenance',
            (candidate->>'correlation_id')::uuid,(candidate->>'expires_at')::timestamptz)
          RETURNING to_jsonb(job_temporary_context) INTO inserted_fact;
      END IF;
    END IF;
    fact_hash := encode(sha256(convert_to((inserted_fact - ARRAY['created_at','updated_at'])::text,'UTF8')),'hex');
  END IF;

  -- No job filter: corrected attribution must retire the old job's same-source
  -- evidence too. Other extractors and independent source rows are untouched.
  FOREACH target IN ARRAY ARRAY['job_context','job_temporary_context'] LOOP
    EXECUTE format($update$
      UPDATE public.%I SET provenance =
        jsonb_set(provenance, '{safety}', coalesce(provenance->'safety','{}'::jsonb) || '{"memory_trusted":false}'::jsonb)
        || jsonb_build_object('lifecycle', $3, 'superseded_by', $4, 'superseded_at', $5,
          'retired_by_source_revision_sha256', $6), updated_at = $5
      WHERE provenance->>'extractor' = $1 AND value->'source_refs' @> $2
        AND coalesce(provenance->>'lifecycle','active') = 'active'
        AND ($4 IS NULL OR id <> $4)
    $update$, target) USING extractor, refs, CASE WHEN retract THEN 'retracted' ELSE 'superseded' END,
      fact_uuid, at_time, revision;
  END LOOP;
  UPDATE public.luna_context_source_revisions SET lifecycle = CASE WHEN retract THEN 'retracted' ELSE 'superseded' END
    WHERE source_table = p_source_table AND source_id = source_uuid AND lifecycle = 'active';
  IF prior.source_id IS NULL THEN
  INSERT INTO public.luna_context_source_revisions
    (source_table,source_id,source_revision_sha256,lifecycle,fact_store,fact_id,fact_sha256)
    VALUES (p_source_table,source_uuid,revision,CASE WHEN retract THEN 'retracted' ELSE 'active' END,
      p_store,fact_uuid,fact_hash);
  END IF;
  RETURN jsonb_build_object('fact_id', fact_uuid, 'outcome', CASE WHEN retract THEN 'retracted'
    WHEN existing_store IS NOT NULL THEN 'idempotent' ELSE 'inserted' END);
EXCEPTION WHEN OTHERS THEN
  -- Constraint failure details can include complete source-derived fact text.
  -- Expose only our static errors; PL/pgSQL rolls back every write in this call.
  IF SQLERRM LIKE 'luna\_%' ESCAPE '\' THEN RAISE; END IF;
  RAISE EXCEPTION 'luna_context_revision_failed';
END;
$function$;
REVOKE ALL ON FUNCTION public.persist_luna_context_revision(text,text,jsonb,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_luna_context_revision(text,text,jsonb,text,jsonb) TO service_role;
COMMENT ON FUNCTION public.persist_luna_context_revision(text,text,jsonb,text,jsonb) IS
  'Service-only source-row CAS, immutable revision receipts, and atomic Luna fact replacement/retraction. No provider or business actions.';
COMMIT;
