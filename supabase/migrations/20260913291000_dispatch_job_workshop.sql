-- Dispatch job-first workshop adapter (DISPATCH-WORKSHOP.md).
-- Works without a registered AI assessor. Whole-job history; optional PO filter.

CREATE OR REPLACE FUNCTION public.read_dispatch_job_workshop(
  p_org_id uuid, p_job_id uuid, p_po_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  job jsonb;
  plan public.dispatch_plans;
  src text;
  src_err text;
  docs jsonb;
  comms jsonb;
  facts jsonb;
BEGIN
  IF p_org_id IS NULL OR p_job_id IS NULL THEN RAISE EXCEPTION 'workshop_invalid'; END IF;
  SELECT to_jsonb(j) INTO job
    FROM public.jobs j WHERE j.id=p_job_id AND j.org_id=p_org_id;
  IF job IS NULL THEN RAISE EXCEPTION 'workshop_job_org_mismatch'; END IF;

  SELECT * INTO plan FROM public.dispatch_plans
   WHERE org_id=p_org_id AND job_id=p_job_id;

  BEGIN
    src := public.dispatch_source_version(p_org_id, p_job_id);
  EXCEPTION WHEN OTHERS THEN
    src := NULL;
    src_err := SQLERRM;
  END;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', d.id, 'type', d.type, 'file_name', d.file_name, 'storage_url', d.storage_url
    ) ORDER BY d.type, d.file_name), '[]'::jsonb)
    INTO docs
    FROM public.job_documents d
   WHERE d.job_id=p_job_id AND d.superseded_at IS NULL;

  comms := public.list_job_communications(p_org_id, p_job_id, p_po_id, NULL);

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', f.id, 'kind', f.kind, 'value', f.value, 'lifecycle', f.lifecycle
    ) ORDER BY f.updated_at), '[]'::jsonb)
    INTO facts
    FROM public.current_job_context_facts f
   WHERE f.job_id=p_job_id AND f.lifecycle='current';

  RETURN jsonb_build_object(
    'org_id', p_org_id,
    'job_id', p_job_id,
    'po_id', p_po_id,
    'job', job,
    'grounding', jsonb_build_object(
      'job_number', job->>'job_number',
      'status', job->>'status',
      'type', job->>'type',
      'plan_version', plan.version,
      'groups', coalesce(plan.state->'groups', '[]'::jsonb),
      'requirements', coalesce(plan.state->'requirements', '[]'::jsonb),
      'notes', coalesce(plan.state->'notes', '[]'::jsonb),
      'order_drafts', coalesce(plan.state->'order_drafts', '[]'::jsonb)
    ),
    'documents', coalesce(docs, '[]'::jsonb),
    'communications', comms,
    'current_facts', coalesce(facts, '[]'::jsonb),
    'source_revision', src,
    'source_error', src_err,
    'ai_assessor_required', false,
    'source_reload_is_not_assessment', true
  );
END $$;

REVOKE ALL ON FUNCTION public.read_dispatch_job_workshop(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_dispatch_job_workshop(uuid,uuid,uuid) TO service_role;
