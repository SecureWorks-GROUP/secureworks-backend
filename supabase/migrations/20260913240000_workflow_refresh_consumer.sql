-- Dispatchable refresh consumer, lease-gated finish, workflow/scope allowlist.
-- Queued clicks are owned by consume_dispatch_refresh / consume_workflow_refresh.

CREATE OR REPLACE FUNCTION public.workflow_refresh_scope_allowed(p_scope jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_typeof(p_scope) IS NOT DISTINCT FROM 'object'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_scope) k
       WHERE k NOT IN ('job_id','org_id','week_start')
     );
$$;

CREATE OR REPLACE FUNCTION public.start_workflow_refresh(p_workflow text, p_scope jsonb, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE existing public.workflow_refresh_runs; created public.workflow_refresh_runs;
BEGIN
  IF p_workflow IS NULL OR p_workflow NOT IN ('dispatch','debt','ses','booking','performance')
     OR NOT public.workflow_refresh_scope_allowed(p_scope)
     OR nullif(btrim(p_actor),'') IS NULL
  THEN RAISE EXCEPTION 'workflow_refresh_invalid'; END IF;
  SELECT * INTO existing FROM public.workflow_refresh_runs
   WHERE workflow=p_workflow AND scope=p_scope AND status IN ('queued','running')
   FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('outcome','joined','id',existing.id,'status',existing.status,
      'lease_token',existing.lease_token,'owner',existing.workflow,'scope',existing.scope);
  END IF;
  INSERT INTO public.workflow_refresh_runs(workflow,scope,status,requested_by,lease_token)
   VALUES(p_workflow,p_scope,'queued',p_actor,gen_random_uuid())
   RETURNING * INTO created;
  RETURN jsonb_build_object('outcome','started','id',created.id,'status',created.status,
    'lease_token',created.lease_token,'owner',created.workflow,'scope',created.scope);
END $$;

DROP FUNCTION IF EXISTS public.finish_workflow_refresh(uuid,text,jsonb,timestamptz);

CREATE OR REPLACE FUNCTION public.finish_workflow_refresh(
  p_id uuid, p_status text, p_result jsonb, p_cutoff timestamptz, p_lease uuid, p_owner text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE run public.workflow_refresh_runs;
BEGIN
  IF p_status NOT IN ('completed','partial','failed') OR p_lease IS NULL OR nullif(btrim(p_owner),'') IS NULL
  THEN RAISE EXCEPTION 'workflow_refresh_invalid'; END IF;
  SELECT * INTO run FROM public.workflow_refresh_runs WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow_refresh_not_active'; END IF;
  IF run.lease_token IS DISTINCT FROM p_lease OR run.workflow IS DISTINCT FROM p_owner
     OR run.status NOT IN ('queued','running')
  THEN RAISE EXCEPTION 'workflow_refresh_lease_mismatch'; END IF;
  UPDATE public.workflow_refresh_runs
   SET status=p_status, result=coalesce(p_result,'{}'::jsonb), source_cutoff=p_cutoff, updated_at=now()
   WHERE id=p_id;
  RETURN jsonb_build_object('ok',true,'id',p_id,'status',p_status,'owner',p_owner);
END $$;

CREATE OR REPLACE FUNCTION public.workflow_refresh_readback(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT to_jsonb(r) FROM public.workflow_refresh_runs r WHERE r.id=p_id;
$$;

CREATE OR REPLACE FUNCTION public.consume_dispatch_refresh(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE run public.workflow_refresh_runs; progress jsonb; src text;
BEGIN
  SELECT * INTO run FROM public.workflow_refresh_runs WHERE id=p_id AND workflow='dispatch' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow_refresh_owner_mismatch'; END IF;
  IF run.status='queued'
     OR (run.status='running' AND run.updated_at < now() - interval '15 minutes') THEN
    UPDATE public.workflow_refresh_runs
       SET status='running', updated_at=now(),
           lease_token=coalesce(lease_token, gen_random_uuid()),
           result=jsonb_build_object('owner','dispatch','step','claimed')
     WHERE id=p_id
     RETURNING * INTO run;
  ELSIF run.status IS DISTINCT FROM 'running' THEN
    RAISE EXCEPTION 'workflow_refresh_not_active';
  END IF;
  src := NULL;
  BEGIN
    IF (run.scope ? 'job_id') AND (run.scope ? 'org_id') THEN
      src := public.dispatch_source_version((run.scope->>'org_id')::uuid, (run.scope->>'job_id')::uuid);
    END IF;
  EXCEPTION WHEN OTHERS THEN src := NULL;
  END;
  progress := jsonb_build_object(
    'owner','dispatch','step','source_read','scope',run.scope,
    'source_hash',src,'lease_token',run.lease_token);
  UPDATE public.workflow_refresh_runs
     SET status='completed', result=progress, source_cutoff=now(), updated_at=now()
   WHERE id=p_id AND status='running';
  RETURN jsonb_build_object('ok',true,'id',p_id,'status','completed','owner','dispatch',
    'source_hash',src,'lease_token',run.lease_token);
END $$;

CREATE OR REPLACE FUNCTION public.consume_workflow_refresh(p_owner text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE run public.workflow_refresh_runs;
BEGIN
  IF p_owner IS DISTINCT FROM 'dispatch' THEN RAISE EXCEPTION 'workflow_refresh_unknown_owner'; END IF;
  SELECT * INTO run FROM public.workflow_refresh_runs
   WHERE workflow=p_owner AND status='queued'
   ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN
    SELECT * INTO run FROM public.workflow_refresh_runs
     WHERE workflow=p_owner AND status='running'
       AND updated_at < now() - interval '15 minutes'
     ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT 1;
  END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','idle','owner',p_owner); END IF;
  RETURN public.consume_dispatch_refresh(run.id);
END $$;

REVOKE ALL ON FUNCTION public.workflow_refresh_scope_allowed(jsonb),
 public.start_workflow_refresh(text,jsonb,text),
 public.finish_workflow_refresh(uuid,text,jsonb,timestamptz,uuid,text),
 public.workflow_refresh_readback(uuid),
 public.consume_dispatch_refresh(uuid),
 public.consume_workflow_refresh(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_refresh_scope_allowed(jsonb),
 public.start_workflow_refresh(text,jsonb,text),
 public.finish_workflow_refresh(uuid,text,jsonb,timestamptz,uuid,text),
 public.workflow_refresh_readback(uuid),
 public.consume_dispatch_refresh(uuid),
 public.consume_workflow_refresh(text) TO service_role;
