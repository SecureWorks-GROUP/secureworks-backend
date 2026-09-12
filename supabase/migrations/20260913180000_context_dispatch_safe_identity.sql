-- Repair: TEXT job_id vs UUID jobs.id, and non-throwing integer/uuid casts.
-- Canonical create is TEXT (20260316000005). Projection output is UUID.
-- Guards are plpgsql helpers with EXCEPTION; not WHERE-order dependent.

CREATE OR REPLACE FUNCTION public.context_safe_uuid(p text)
RETURNS uuid LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
  IF p IS NULL OR p !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' THEN
    RETURN NULL;
  END IF;
  RETURN p::uuid;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.context_safe_positive_int(p text)
RETURNS integer LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE n bigint;
BEGIN
  IF p IS NULL OR p !~ '^[1-9][0-9]*$' THEN RETURN NULL; END IF;
  n := p::bigint;
  IF n > 2147483647 THEN RETURN NULL; END IF;
  RETURN n::integer;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.context_safe_uuid(text), public.context_safe_positive_int(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_safe_uuid(text), public.context_safe_positive_int(text) TO service_role;

CREATE OR REPLACE VIEW public.context_dispatch_working_facts WITH (security_invoker=true) AS
SELECT DISTINCT ON (public.context_safe_uuid(b.job_id::text))
  b.id,
  public.context_safe_uuid(b.job_id::text) AS job_id,
  'note'::text AS kind,
  jsonb_build_object(
    'text','Dispatch working review state. Not a claim that an order was sent, purchased, delivered or paid.',
    'command',b.payload->>'command',
    'plan_version',public.context_safe_positive_int(b.payload->>'plan_version'),
    'source_version',b.payload->>'source_version',
    'state',b.payload->'state',
    'source_refs',jsonb_build_array(jsonb_build_object('table','business_events','id',b.id::text))
  ) AS value,
  jsonb_build_object(
    'extractor','dispatch_working_state_v1',
    'writer_role','dispatch_working_state_projector',
    'untrusted',false,
    'lifecycle','active',
    'source_event_ids',jsonb_build_array(b.id),
    'event_at',b.event_at,
    'validity_basis','ongoing',
    'source_event_at',b.event_at,
    'derivation',jsonb_build_object(
      'owner','dispatch',
      'event_id',b.metadata#>>'{derivation,event_id}',
      'plan_version',public.context_safe_positive_int(b.payload->>'plan_version'),
      'org_id',b.payload->>'org_id',
      'job_id',public.context_safe_uuid(b.job_id::text),
      'request_id',b.metadata#>>'{derivation,event_id}',
      'source_event_ids',jsonb_build_array(b.id),
      'rule_version','dispatch_working_state_v1',
      'own_only',true
    ),
    'evidence_role','human_working_state',
    'provider_action',false,
    'safety',jsonb_build_object('memory_trusted',true,'action_safe',false,'state_change_safe',false,'outbound_safe',false)
  ) AS provenance,
  b.correlation_id,
  b.event_at AS created_at,
  b.event_at AS updated_at,
  NULL::timestamptz AS expires_at,
  'dispatch_projection'::text AS _context_store,
  'current'::text AS lifecycle,
  (timezone('Australia/Perth',b.event_at))::date AS event_date,
  ARRAY[b.id]::uuid[] AS source_event_ids,
  1::numeric AS attribution_confidence,
  'dispatch_working_state_v1'::text AS extractor_version,
  NULL::uuid AS superseded_by,
  NULL::text AS lifecycle_reason,
  'dispatch_working_state'::text AS trust,
  NULL::timestamptz AS review_at,
  'ongoing'::text AS validity_basis,
  NULL::timestamptz AS last_verified_at,
  b.event_at AS source_event_at
FROM public.business_events b
JOIN public.jobs j ON j.id=public.context_safe_uuid(b.job_id::text)
WHERE b.event_type='dispatch.plan.changed'
  AND b.source='ops-api'
  AND b.entity_type='dispatch_plan'
  AND b.entity_id=b.job_id::text
  AND b.match_status='matched'
  AND b.match_method IN ('direct_job_id','direct_reference','manual')
  AND b.metadata->>'evidence_role'='human_working_state'
  AND b.metadata->>'provider_action'='false'
  AND b.payload->>'contract_version'='dispatch-context/v1'
  AND jsonb_typeof(b.payload->'state')='object'
  AND public.context_safe_uuid(b.job_id::text) IS NOT NULL
  AND public.context_safe_uuid(b.payload->>'job_id') IS NOT NULL
  AND public.context_safe_uuid(b.payload->>'org_id') IS NOT NULL
  AND public.context_safe_uuid(b.metadata#>>'{derivation,event_id}') IS NOT NULL
  AND public.context_safe_positive_int(b.payload->>'plan_version') IS NOT NULL
  AND public.context_safe_positive_int(b.metadata#>>'{derivation,plan_version}') IS NOT NULL
  AND public.context_safe_positive_int(b.metadata#>>'{source_ref,version}') IS NOT NULL
  AND b.correlation_id IS NOT NULL
  AND b.event_at IS NOT NULL
  AND public.context_safe_uuid(b.payload->>'org_id')=j.org_id
  AND public.context_safe_uuid(b.payload->>'job_id')=public.context_safe_uuid(b.job_id::text)
  AND b.metadata#>>'{derivation,owner}'='dispatch'
  AND public.context_safe_uuid(b.metadata#>>'{derivation,event_id}')=b.correlation_id
  AND public.context_safe_positive_int(b.metadata#>>'{derivation,plan_version}')=public.context_safe_positive_int(b.payload->>'plan_version')
  AND b.metadata#>>'{source_ref,table}'='dispatch_plans'
  AND public.context_safe_uuid(b.metadata#>>'{source_ref,org_id}')=public.context_safe_uuid(b.payload->>'org_id')
  AND public.context_safe_uuid(b.metadata#>>'{source_ref,job_id}')=public.context_safe_uuid(b.payload->>'job_id')
  AND public.context_safe_positive_int(b.metadata#>>'{source_ref,version}')=public.context_safe_positive_int(b.payload->>'plan_version')
  AND coalesce(to_jsonb(b)->>'retracted_at','')=''
  AND coalesce(b.metadata->>'retracted_at','')=''
  AND coalesce(to_jsonb(b)->>'retracted','') IS DISTINCT FROM 'true'
  AND coalesce(b.metadata->>'retracted','') IS DISTINCT FROM 'true'
ORDER BY public.context_safe_uuid(b.job_id::text), public.context_safe_positive_int(b.payload->>'plan_version') DESC NULLS LAST, b.id DESC;
