-- Shared Refresh driver contract.
-- CIO owns start/claim/finish/readback security. Domain owners register drivers.
-- A source-hash read is not completed Refresh. Unsupported workflows are not queued.

ALTER TABLE public.workflow_refresh_runs
  ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS lease_generation integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS expected_source_revision text;

CREATE TABLE IF NOT EXISTS public.workflow_refresh_drivers (
  workflow text PRIMARY KEY CHECK (workflow IN ('dispatch','debt','ses','booking','performance')),
  owner_role text NOT NULL,
  capability text NOT NULL CHECK (capability IN ('registered','unavailable')),
  declared_output text NOT NULL,
  note text NOT NULL DEFAULT '',
  registered_at timestamptz,
  registered_by text
);
ALTER TABLE public.workflow_refresh_drivers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workflow_refresh_drivers FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.workflow_refresh_drivers TO service_role;

INSERT INTO public.workflow_refresh_drivers(workflow, owner_role, capability, declared_output, note)
VALUES
 ('dispatch','operations','unavailable','dispatch_refresh/v1','Operations registers the Dispatch driver. CIO does not complete a source-hash read as Refresh.'),
 ('debt','debt-collection','unavailable','debt_refresh/v1','Debt Collection registers this driver.'),
 ('ses','insurance','unavailable','ses_refresh/v1','Insurance registers this driver.'),
 ('booking','patio-sales','unavailable','booking_refresh/v1','Patio Sales registers this driver.'),
 ('performance','fencing-sales','unavailable','performance_refresh/v1','Fencing Sales registers this driver.')
ON CONFLICT (workflow) DO NOTHING;

CREATE OR REPLACE FUNCTION public.register_workflow_refresh_driver(
  p_workflow text, p_owner_role text, p_declared_output text, p_actor text, p_capability text DEFAULT 'registered')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_capability NOT IN ('registered','unavailable') OR nullif(btrim(p_actor),'') IS NULL
  THEN RAISE EXCEPTION 'workflow_refresh_invalid'; END IF;
  UPDATE public.workflow_refresh_drivers
     SET owner_role=p_owner_role, declared_output=p_declared_output, capability=p_capability,
         registered_at=CASE WHEN p_capability='registered' THEN now() ELSE NULL END,
         registered_by=p_actor, note=coalesce(note,'')
   WHERE workflow=p_workflow;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow_refresh_unknown_owner'; END IF;
  RETURN jsonb_build_object('ok',true,'workflow',p_workflow,'capability',p_capability,'owner_role',p_owner_role);
END $$;

CREATE OR REPLACE FUNCTION public.start_workflow_refresh(
  p_workflow text, p_scope jsonb, p_actor text, p_org_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE existing public.workflow_refresh_runs; created public.workflow_refresh_runs;
  driver public.workflow_refresh_drivers; scoped jsonb;
BEGIN
  IF p_org_id IS NULL OR p_workflow IS NULL OR p_workflow NOT IN ('dispatch','debt','ses','booking','performance')
     OR NOT public.workflow_refresh_scope_allowed(p_scope)
     OR nullif(btrim(p_actor),'') IS NULL
  THEN RAISE EXCEPTION 'workflow_refresh_invalid'; END IF;
  IF (p_scope ? 'org_id') AND (p_scope->>'org_id') IS DISTINCT FROM p_org_id::text
  THEN RAISE EXCEPTION 'workflow_refresh_org_mismatch'; END IF;
  scoped := coalesce(p_scope,'{}'::jsonb) || jsonb_build_object('org_id', p_org_id);
  IF scoped ? 'job_id' AND NOT EXISTS (
    SELECT 1 FROM public.jobs j WHERE j.org_id=p_org_id AND j.id::text=scoped->>'job_id'
  ) THEN RAISE EXCEPTION 'workflow_refresh_scope_missing'; END IF;
  SELECT * INTO driver FROM public.workflow_refresh_drivers WHERE workflow=p_workflow;
  IF driver.capability IS DISTINCT FROM 'registered' THEN
    RETURN jsonb_build_object(
      'outcome','unavailable','workflow',p_workflow,'capability','unavailable',
      'owner_role',driver.owner_role,'declared_output',driver.declared_output,
      'reason','driver_not_registered');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workflow || ':' || scoped::text, 0));
  BEGIN
    SELECT * INTO existing FROM public.workflow_refresh_runs
     WHERE workflow=p_workflow AND scope=scoped AND status IN ('queued','running')
     FOR UPDATE;
    IF FOUND THEN
      RETURN jsonb_build_object('outcome','joined','id',existing.id,'status',existing.status,
        'owner',existing.workflow,'scope',existing.scope,'org_id',existing.org_id,
        'lease_generation',existing.lease_generation);
    END IF;
    INSERT INTO public.workflow_refresh_runs(workflow,scope,status,requested_by,lease_token,org_id,lease_generation)
     VALUES(p_workflow,scoped,'queued',p_actor,NULL,p_org_id,0)
     RETURNING * INTO created;
    RETURN jsonb_build_object('outcome','started','id',created.id,'status',created.status,
      'owner',created.workflow,'scope',created.scope,'org_id',created.org_id,
      'lease_generation',created.lease_generation);
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO existing FROM public.workflow_refresh_runs
     WHERE workflow=p_workflow AND scope=scoped AND status IN ('queued','running')
     FOR UPDATE;
    IF NOT FOUND THEN RAISE; END IF;
    RETURN jsonb_build_object('outcome','joined','id',existing.id,'status',existing.status,
      'owner',existing.workflow,'scope',existing.scope,'org_id',existing.org_id,
      'lease_generation',existing.lease_generation);
  END;
END $$;

CREATE OR REPLACE FUNCTION public.claim_workflow_refresh(
  p_id uuid, p_owner text, p_lease uuid, p_generation integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE run public.workflow_refresh_runs; src text; new_lease uuid; new_gen int;
BEGIN
  IF p_id IS NULL OR p_owner IS NULL THEN RAISE EXCEPTION 'workflow_refresh_invalid'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.workflow_refresh_drivers d
     WHERE d.workflow=p_owner AND d.capability='registered'
  ) THEN RAISE EXCEPTION 'workflow_refresh_driver_unavailable'; END IF;
  SELECT * INTO run FROM public.workflow_refresh_runs WHERE id=p_id AND workflow=p_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow_refresh_owner_mismatch'; END IF;
  IF run.status='queued' THEN
    IF p_lease IS NOT NULL THEN RAISE EXCEPTION 'workflow_refresh_lease_mismatch'; END IF;
    new_lease := gen_random_uuid(); new_gen := 1;
    src := NULL;
    BEGIN
      IF (run.scope ? 'job_id') THEN
        src := public.dispatch_source_version(run.org_id, (run.scope->>'job_id')::uuid);
      END IF;
    EXCEPTION WHEN OTHERS THEN src := NULL;
    END;
    UPDATE public.workflow_refresh_runs
       SET status='running', lease_token=new_lease, lease_generation=new_gen,
           expected_source_revision=src, updated_at=now(),
           result=jsonb_build_object('owner',p_owner,'step','claimed','expected_source_revision',src)
     WHERE id=p_id;
    RETURN jsonb_build_object('ok',true,'id',p_id,'status','running','owner',p_owner,
      'lease_token',new_lease,'lease_generation',new_gen,'expected_source_revision',src);
  END IF;
  IF run.status='running' THEN
    IF run.lease_token IS DISTINCT FROM p_lease OR run.lease_generation IS DISTINCT FROM p_generation
    THEN RAISE EXCEPTION 'workflow_refresh_lease_mismatch'; END IF;
    IF run.updated_at >= now() - interval '15 minutes'
    THEN RAISE EXCEPTION 'workflow_refresh_not_active'; END IF;
    new_lease := gen_random_uuid(); new_gen := run.lease_generation + 1;
    UPDATE public.workflow_refresh_runs
       SET lease_token=new_lease, lease_generation=new_gen, updated_at=now(),
           result=jsonb_build_object('owner',p_owner,'step','reclaimed','lease_generation',new_gen)
     WHERE id=p_id;
    RETURN jsonb_build_object('ok',true,'id',p_id,'status','running','owner',p_owner,
      'lease_token',new_lease,'lease_generation',new_gen,
      'expected_source_revision',run.expected_source_revision,'recovered',true);
  END IF;
  RAISE EXCEPTION 'workflow_refresh_not_active';
END $$;

DROP FUNCTION IF EXISTS public.finish_workflow_refresh(uuid,text,jsonb,timestamptz,uuid,text);

CREATE OR REPLACE FUNCTION public.finish_workflow_refresh(
  p_id uuid, p_status text, p_result jsonb, p_cutoff timestamptz,
  p_lease uuid, p_owner text, p_generation integer, p_observed_revision text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE run public.workflow_refresh_runs; driver public.workflow_refresh_drivers; final_status text;
BEGIN
  IF p_status NOT IN ('completed','partial','failed') OR p_lease IS NULL OR p_generation IS NULL
     OR nullif(btrim(p_owner),'') IS NULL
  THEN RAISE EXCEPTION 'workflow_refresh_invalid'; END IF;
  SELECT * INTO run FROM public.workflow_refresh_runs WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow_refresh_not_active'; END IF;
  IF run.lease_token IS DISTINCT FROM p_lease OR run.workflow IS DISTINCT FROM p_owner
     OR run.lease_generation IS DISTINCT FROM p_generation OR run.status IS DISTINCT FROM 'running'
  THEN RAISE EXCEPTION 'workflow_refresh_lease_mismatch'; END IF;
  SELECT * INTO driver FROM public.workflow_refresh_drivers WHERE workflow=p_owner;
  final_status := p_status;
  IF p_status='completed' THEN
    IF driver.capability IS DISTINCT FROM 'registered'
       OR coalesce(p_result->>'declared_output','') IS DISTINCT FROM driver.declared_output
       OR coalesce(p_result->>'ok','') IS DISTINCT FROM 'true'
    THEN RAISE EXCEPTION 'workflow_refresh_driver_output_missing'; END IF;
    IF run.expected_source_revision IS NOT NULL
       AND p_observed_revision IS DISTINCT FROM run.expected_source_revision
    THEN final_status := 'partial'; END IF;
  END IF;
  UPDATE public.workflow_refresh_runs
     SET status=final_status, result=coalesce(p_result,'{}'::jsonb), source_cutoff=p_cutoff, updated_at=now()
   WHERE id=p_id;
  RETURN jsonb_build_object('ok',true,'id',p_id,'status',final_status,'owner',p_owner);
END $$;

DROP FUNCTION IF EXISTS public.workflow_refresh_readback(uuid);

CREATE OR REPLACE FUNCTION public.workflow_refresh_readback(p_id uuid, p_org_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE run public.workflow_refresh_runs; out jsonb;
BEGIN
  IF p_id IS NULL OR p_org_id IS NULL THEN RAISE EXCEPTION 'workflow_refresh_invalid'; END IF;
  SELECT * INTO run FROM public.workflow_refresh_runs WHERE id=p_id AND org_id=p_org_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow_refresh_org_mismatch'; END IF;
  out := to_jsonb(run);
  out := out - 'lease_token';
  RETURN out;
END $$;

DROP FUNCTION IF EXISTS public.consume_dispatch_refresh(uuid);
DROP FUNCTION IF EXISTS public.consume_workflow_refresh(text);

CREATE OR REPLACE FUNCTION public.consume_workflow_refresh(p_owner text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE run public.workflow_refresh_runs;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.workflow_refresh_drivers d
     WHERE d.workflow=p_owner AND d.capability='registered'
  ) THEN RETURN jsonb_build_object('outcome','unavailable','owner',p_owner,'reason','driver_not_registered'); END IF;
  SELECT * INTO run FROM public.workflow_refresh_runs
   WHERE workflow=p_owner AND status='queued'
   ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','idle','owner',p_owner); END IF;
  RETURN public.claim_workflow_refresh(run.id, p_owner, NULL, NULL);
END $$;

-- Old 3-arg start is removed so a missing org cannot queue work.
DROP FUNCTION IF EXISTS public.start_workflow_refresh(text,jsonb,text);

REVOKE ALL ON FUNCTION public.register_workflow_refresh_driver(text,text,text,text,text),
 public.start_workflow_refresh(text,jsonb,text,uuid),
 public.claim_workflow_refresh(uuid,text,uuid,integer),
 public.finish_workflow_refresh(uuid,text,jsonb,timestamptz,uuid,text,integer,text),
 public.workflow_refresh_readback(uuid,uuid),
 public.consume_workflow_refresh(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.register_workflow_refresh_driver(text,text,text,text,text),
 public.start_workflow_refresh(text,jsonb,text,uuid),
 public.claim_workflow_refresh(uuid,text,uuid,integer),
 public.finish_workflow_refresh(uuid,text,jsonb,timestamptz,uuid,text,integer,text),
 public.workflow_refresh_readback(uuid,uuid),
 public.consume_workflow_refresh(text) TO service_role;
