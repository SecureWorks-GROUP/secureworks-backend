-- Organisation memory + durable cutover eligibility. Does not alter the
-- pinned Dispatch projector. Tenant fail-closed. Customer text is not policy.

CREATE TABLE public.organisation_context (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES public.organisations(id),
 kind text NOT NULL CHECK (kind IN ('operating_constraint','supplier_capability','contact_detail','current_state','note')),
 value jsonb NOT NULL,
 provenance jsonb NOT NULL DEFAULT '{}',
 correlation_id uuid,
 lifecycle text NOT NULL DEFAULT 'current' CHECK (lifecycle IN ('current','superseded','retracted')),
 source_event_ids uuid[] NOT NULL DEFAULT '{}',
 extractor_version text,
 trust text NOT NULL DEFAULT 'luna' CHECK (trust IN ('luna','legacy')),
 validity_basis text NOT NULL DEFAULT 'unknown_end' CHECK (validity_basis IN ('explicit_end','ongoing','uncertain','unknown_end')),
 subject_refs jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organisation_context_org_current ON public.organisation_context(org_id,kind) WHERE lifecycle='current';
ALTER TABLE public.organisation_context ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.organisation_context FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.organisation_context TO service_role;

CREATE OR REPLACE VIEW public.current_organisation_context_facts WITH (security_invoker=true) AS
SELECT id,org_id,kind,value,provenance,correlation_id,created_at,updated_at,
 source_event_ids,extractor_version,trust,validity_basis,subject_refs
FROM public.organisation_context
WHERE lifecycle='current'
 AND provenance#>'{safety,memory_trusted}' IS DISTINCT FROM 'false'::jsonb;
REVOKE ALL ON public.current_organisation_context_facts FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.current_organisation_context_facts TO service_role;

CREATE OR REPLACE FUNCTION public.persist_luna_organisation_revision(
 p_org_id uuid, p_events jsonb, p_new jsonb, p_extractor_version text DEFAULT 'luna_v2')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f jsonb; kind text; refs uuid[]; ev jsonb; actual jsonb; n int:=0; fact_id uuid; source_kind text;
BEGIN
 IF p_org_id IS NULL OR jsonb_typeof(p_events) IS DISTINCT FROM 'array' OR jsonb_typeof(p_new) IS DISTINCT FROM 'array'
  OR p_extractor_version IS DISTINCT FROM 'luna_v2'
 THEN RAISE EXCEPTION 'luna_org_revision_invalid'; END IF;
 IF NOT public.automation_lane_enabled('extraction') THEN RETURN jsonb_build_object('outcome','held','reason','lane'); END IF;
 FOR ev IN SELECT value FROM jsonb_array_elements(p_events) LOOP
  IF ev->>'id' IS NULL THEN RAISE EXCEPTION 'luna_source_identity_invalid'; END IF;
  SELECT to_jsonb(b) INTO actual FROM public.business_events b WHERE b.id=(ev->>'id')::uuid FOR UPDATE;
  IF actual IS NULL THEN RAISE EXCEPTION 'luna_source_revision_stale'; END IF;
  IF coalesce(actual#>>'{payload,org_id}', actual->>'org_id') IS DISTINCT FROM p_org_id::text
  THEN RAISE EXCEPTION 'luna_org_tenant_mismatch'; END IF;
 END LOOP;
 FOR f IN SELECT value FROM jsonb_array_elements(p_new) LOOP
  kind:=f->>'kind';
  IF kind IS NULL OR kind NOT IN ('operating_constraint','supplier_capability','contact_detail','current_state','note')
  THEN RAISE EXCEPTION 'luna_org_kind_invalid'; END IF;
  source_kind:=coalesce(f->>'source_kind','internal');
  IF kind='operating_constraint' AND source_kind IN ('customer','supplier') THEN
   RAISE EXCEPTION 'luna_org_policy_source_rejected';
  END IF;
  SELECT array_agg((value->>'id')::uuid) INTO refs FROM jsonb_array_elements(p_events);
  fact_id:=gen_random_uuid();
  INSERT INTO public.organisation_context(id,org_id,kind,value,provenance,source_event_ids,extractor_version,trust,validity_basis,subject_refs)
  VALUES(fact_id,p_org_id,kind,jsonb_build_object('text',f->>'text'),
   jsonb_build_object('extractor','luna_v2','writer_role','classifier','lifecycle','active',
    'safety',jsonb_build_object('memory_trusted',true,'action_safe',false)),
   coalesce(refs,'{}'), 'luna_v2','luna',coalesce(f->>'validity_basis','unknown_end'), coalesce(f->'subject_refs','[]'::jsonb));
  n:=n+1;
 END LOOP;
 RETURN jsonb_build_object('outcome','ok','inserted',n);
END $$;
REVOKE ALL ON FUNCTION public.persist_luna_organisation_revision(uuid,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.persist_luna_organisation_revision(uuid,jsonb,jsonb,text) TO service_role;

CREATE TABLE public.context_cutover_boundaries (
 org_id uuid PRIMARY KEY REFERENCES public.organisations(id),
 eligible_from timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.context_cutover_boundaries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.context_cutover_boundaries FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.context_cutover_boundaries TO service_role;

CREATE OR REPLACE FUNCTION public.persist_context_cutover_boundary(p_org_id uuid, p_eligible_from timestamptz)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE existing timestamptz;
BEGIN
 IF p_org_id IS NULL OR p_eligible_from IS NULL THEN RAISE EXCEPTION 'context_cutover_invalid'; END IF;
 SELECT eligible_from INTO existing FROM public.context_cutover_boundaries WHERE org_id=p_org_id;
 IF existing IS NOT NULL THEN RETURN existing; END IF;
 INSERT INTO public.context_cutover_boundaries(org_id,eligible_from) VALUES(p_org_id,p_eligible_from);
 RETURN p_eligible_from;
END $$;
CREATE OR REPLACE FUNCTION public.context_event_cutover_eligible(p_org_id uuid, p_captured_at timestamptz)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE boundary timestamptz;
BEGIN
 IF p_org_id IS NULL OR p_captured_at IS NULL THEN RETURN false; END IF;
 SELECT eligible_from INTO boundary FROM public.context_cutover_boundaries WHERE org_id=p_org_id;
 IF boundary IS NULL THEN RETURN false; END IF;
 RETURN p_captured_at > boundary;
END $$;
REVOKE ALL ON FUNCTION public.persist_context_cutover_boundary(uuid,timestamptz), public.context_event_cutover_eligible(uuid,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.persist_context_cutover_boundary(uuid,timestamptz), public.context_event_cutover_eligible(uuid,timestamptz) TO service_role;
