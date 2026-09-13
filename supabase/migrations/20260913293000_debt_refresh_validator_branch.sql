-- Open debt_source_v1 so start(debt) can use invoice/book scope without job_id.
-- Does not implement debt_source_version or register debt. No cache write.

ALTER TABLE public.workflow_refresh_drivers
  DROP CONSTRAINT IF EXISTS workflow_refresh_drivers_validator_key_check;
ALTER TABLE public.workflow_refresh_drivers
  ADD CONSTRAINT workflow_refresh_drivers_validator_key_check
  CHECK (validator_key IN ('dispatch_source_v1','debt_source_v1','none'));

CREATE OR REPLACE FUNCTION public.workflow_refresh_scope_allowed(p_scope jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_typeof(p_scope) IS NOT DISTINCT FROM 'object'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_scope) k
       WHERE k NOT IN ('job_id','org_id','week_start','xero_invoice_id','population')
     );
$$;

CREATE OR REPLACE FUNCTION public.workflow_refresh_driver_is_ready(p_workflow text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d public.workflow_refresh_drivers;
BEGIN
  SELECT * INTO d FROM public.workflow_refresh_drivers WHERE workflow=p_workflow;
  IF NOT FOUND OR d.capability IS DISTINCT FROM 'registered' THEN RETURN false; END IF;
  IF p_workflow='dispatch' THEN
    RETURN d.validator_key='dispatch_source_v1'
       AND to_regprocedure('public.dispatch_source_version(uuid,uuid)') IS NOT NULL
       AND to_regclass('public.dispatch_commands') IS NOT NULL
       AND to_regclass('public.dispatch_plans') IS NOT NULL;
  END IF;
  IF p_workflow='debt' THEN
    RETURN d.validator_key='debt_source_v1'
       AND d.declared_output='debt_refresh/v1'
       AND to_regprocedure('public.debt_source_version(uuid,uuid)') IS NOT NULL
       AND to_regclass('public.debt_assess_commands') IS NOT NULL;
  END IF;
  RETURN false;
END $$;

CREATE OR REPLACE FUNCTION public.register_workflow_refresh_driver(
  p_workflow text, p_owner_role text, p_declared_output text, p_actor text,
  p_capability text DEFAULT 'registered')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE validator text;
BEGIN
  IF p_workflow IS NULL
     OR p_workflow NOT IN ('dispatch','debt','ses','booking','performance')
     OR p_capability NOT IN ('registered','unavailable')
     OR nullif(btrim(p_actor),'') IS NULL
     OR nullif(btrim(p_owner_role),'') IS NULL
     OR nullif(btrim(p_declared_output),'') IS NULL
  THEN RAISE EXCEPTION 'workflow_refresh_invalid'; END IF;

  IF p_capability='registered' THEN
    IF p_workflow='dispatch' THEN
      IF p_declared_output IS DISTINCT FROM 'dispatch_refresh/v1'
         OR to_regprocedure('public.dispatch_source_version(uuid,uuid)') IS NULL
         OR to_regclass('public.dispatch_commands') IS NULL
         OR to_regclass('public.dispatch_plans') IS NULL
      THEN RAISE EXCEPTION 'workflow_refresh_validator_unavailable'; END IF;
      validator := 'dispatch_source_v1';
    ELSIF p_workflow='debt' THEN
      IF p_declared_output IS DISTINCT FROM 'debt_refresh/v1'
         OR to_regprocedure('public.debt_source_version(uuid,uuid)') IS NULL
         OR to_regclass('public.debt_assess_commands') IS NULL
      THEN RAISE EXCEPTION 'workflow_refresh_validator_unavailable'; END IF;
      validator := 'debt_source_v1';
    ELSE
      RAISE EXCEPTION 'workflow_refresh_validator_unavailable';
    END IF;
  ELSE
    validator := 'none';
  END IF;

  UPDATE public.workflow_refresh_drivers
     SET owner_role=p_owner_role, declared_output=p_declared_output,
         capability=p_capability, validator_key=validator,
         registered_at=CASE WHEN p_capability='registered' THEN now() ELSE NULL END,
         registered_by=p_actor, note=coalesce(note,'')
   WHERE workflow=p_workflow;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow_refresh_unknown_owner'; END IF;
  RETURN jsonb_build_object('ok',true,'workflow',p_workflow,'capability',p_capability,
    'owner_role',p_owner_role,'validator_key',validator);
END $$;

CREATE OR REPLACE FUNCTION public.workflow_refresh_source_revision(
  p_workflow text, p_org_id uuid, p_scope jsonb, p_validator_key text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job_id uuid; inv uuid; source_revision text;
BEGIN
  IF p_org_id IS NULL OR jsonb_typeof(p_scope) IS DISTINCT FROM 'object'
  THEN RAISE EXCEPTION 'workflow_refresh_validator_unavailable'; END IF;

  IF p_workflow='dispatch' AND p_validator_key='dispatch_source_v1' THEN
    IF to_regprocedure('public.dispatch_source_version(uuid,uuid)') IS NULL
       OR nullif(btrim(p_scope->>'job_id'),'') IS NULL
    THEN RAISE EXCEPTION 'workflow_refresh_validator_unavailable'; END IF;
    BEGIN job_id := (p_scope->>'job_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'workflow_refresh_source_unavailable';
    END;
    source_revision := public.dispatch_source_version(p_org_id, job_id);
  ELSIF p_workflow='debt' AND p_validator_key='debt_source_v1' THEN
    IF to_regprocedure('public.debt_source_version(uuid,uuid)') IS NULL
    THEN RAISE EXCEPTION 'workflow_refresh_validator_unavailable'; END IF;
    IF nullif(btrim(p_scope->>'xero_invoice_id'),'') IS NOT NULL THEN
      BEGIN inv := (p_scope->>'xero_invoice_id')::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'workflow_refresh_source_unavailable';
      END;
    ELSIF p_scope->>'population' = 'open' THEN
      inv := '00000000-0000-0000-0000-000000000000'::uuid;
    ELSE
      RAISE EXCEPTION 'workflow_refresh_validator_unavailable';
    END IF;
    source_revision := public.debt_source_version(p_org_id, inv);
  ELSE
    RAISE EXCEPTION 'workflow_refresh_validator_unavailable';
  END IF;

  IF nullif(btrim(source_revision), '') IS NULL THEN
    RAISE EXCEPTION 'workflow_refresh_source_unavailable';
  END IF;
  RETURN source_revision;
END $$;

CREATE OR REPLACE FUNCTION public.start_workflow_refresh(
  p_workflow text, p_scope jsonb, p_actor text, p_org_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE existing public.workflow_refresh_runs; created public.workflow_refresh_runs;
  driver public.workflow_refresh_drivers; scoped jsonb; inv uuid;
BEGIN
  IF p_org_id IS NULL OR p_workflow IS NULL
     OR p_workflow NOT IN ('dispatch','debt','ses','booking','performance')
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
  IF NOT public.workflow_refresh_driver_is_ready(p_workflow) THEN
    RETURN jsonb_build_object(
      'outcome','unavailable','workflow',p_workflow,'capability','unavailable',
      'owner_role',driver.owner_role,'declared_output',driver.declared_output,
      'reason','driver_or_validator_not_registered');
  END IF;
  IF p_workflow='dispatch' THEN
    IF NOT (scoped ? 'job_id') THEN RAISE EXCEPTION 'workflow_refresh_scope_missing'; END IF;
  ELSIF p_workflow='debt' THEN
    IF scoped ? 'xero_invoice_id' THEN
      BEGIN inv := (scoped->>'xero_invoice_id')::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'workflow_refresh_scope_missing';
      END;
      IF NOT EXISTS (
        SELECT 1 FROM public.xero_invoices x
         WHERE x.org_id=p_org_id AND (x.id=inv OR x.xero_invoice_id=inv::text)
      ) THEN RAISE EXCEPTION 'workflow_refresh_scope_missing'; END IF;
    ELSIF scoped->>'population' IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'workflow_refresh_scope_missing';
    END IF;
  ELSE
    RETURN jsonb_build_object(
      'outcome','unavailable','workflow',p_workflow,'capability','unavailable',
      'reason','driver_or_validator_not_registered');
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
DECLARE run public.workflow_refresh_runs; driver public.workflow_refresh_drivers;
  source_revision text; new_lease uuid; new_gen int;
BEGIN
  IF p_id IS NULL OR p_owner IS NULL THEN RAISE EXCEPTION 'workflow_refresh_invalid'; END IF;
  SELECT * INTO driver FROM public.workflow_refresh_drivers WHERE workflow=p_owner;
  IF NOT public.workflow_refresh_driver_is_ready(p_owner)
  THEN RAISE EXCEPTION 'workflow_refresh_driver_unavailable'; END IF;
  SELECT * INTO run FROM public.workflow_refresh_runs WHERE id=p_id AND workflow=p_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow_refresh_owner_mismatch'; END IF;
  IF run.status='queued' THEN
    IF p_lease IS NOT NULL THEN RAISE EXCEPTION 'workflow_refresh_lease_mismatch'; END IF;
    source_revision := public.workflow_refresh_source_revision(
      run.workflow, run.org_id, run.scope, driver.validator_key
    );
    new_lease := gen_random_uuid(); new_gen := 1;
    UPDATE public.workflow_refresh_runs
       SET status='running', lease_token=new_lease, lease_generation=new_gen,
           driver_request_id=gen_random_uuid(),
           expected_source_revision=source_revision, updated_at=now(),
           result=jsonb_build_object('owner',p_owner,'step','claimed',
             'expected_source_revision',source_revision)
     WHERE id=p_id;
    RETURN jsonb_build_object('ok',true,'id',p_id,'status','running','owner',p_owner,
      'lease_token',new_lease,'lease_generation',new_gen,
      'expected_source_revision',source_revision,'driver_request_id',
      (SELECT driver_request_id FROM public.workflow_refresh_runs WHERE id=p_id));
  END IF;
  IF run.status='running' THEN
    IF run.lease_token IS DISTINCT FROM p_lease OR run.lease_generation IS DISTINCT FROM p_generation
    THEN RAISE EXCEPTION 'workflow_refresh_lease_mismatch'; END IF;
    IF run.updated_at >= now() - interval '15 minutes'
    THEN RAISE EXCEPTION 'workflow_refresh_not_active'; END IF;
    source_revision := public.workflow_refresh_source_revision(
      run.workflow, run.org_id, run.scope, driver.validator_key
    );
    new_lease := gen_random_uuid(); new_gen := run.lease_generation + 1;
    UPDATE public.workflow_refresh_runs
       SET lease_token=new_lease, lease_generation=new_gen, updated_at=now(),
           driver_request_id=gen_random_uuid(), expected_source_revision=source_revision,
           result=jsonb_build_object('owner',p_owner,'step','reclaimed',
             'lease_generation',new_gen,'expected_source_revision',source_revision)
     WHERE id=p_id;
    RETURN jsonb_build_object('ok',true,'id',p_id,'status','running','owner',p_owner,
      'lease_token',new_lease,'lease_generation',new_gen,
      'expected_source_revision',source_revision,'driver_request_id',
      (SELECT driver_request_id FROM public.workflow_refresh_runs WHERE id=p_id),
      'recovered',true);
  END IF;
  RAISE EXCEPTION 'workflow_refresh_not_active';
END $$;

CREATE OR REPLACE FUNCTION public.record_workflow_refresh_receipt(
  p_run_id uuid,
  p_owner text,
  p_lease uuid,
  p_generation integer,
  p_driver_version text,
  p_scope jsonb,
  p_output jsonb,
  p_observed_revision text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  run public.workflow_refresh_runs;
  driver public.workflow_refresh_drivers;
  receipt public.workflow_refresh_receipts;
  source_revision text;
  output_request_id uuid;
  command_org_id uuid;
  command_job_id uuid;
  command_invoice_id uuid;
  command_created_at timestamptz;
  command_name text;
  command_result jsonb;
  plan_version bigint;
  plan_source text;
  plan_state jsonb;
  result_version bigint;
  expected_job_id uuid;
  expected_invoice_id uuid;
BEGIN
  IF p_run_id IS NULL OR nullif(btrim(p_owner),'') IS NULL OR p_lease IS NULL
     OR p_generation IS NULL OR nullif(btrim(p_driver_version),'') IS NULL
     OR jsonb_typeof(p_scope) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_output) IS DISTINCT FROM 'object'
     OR nullif(btrim(p_observed_revision),'') IS NULL
  THEN RAISE EXCEPTION 'workflow_refresh_receipt_invalid'; END IF;

  SELECT * INTO run FROM public.workflow_refresh_runs WHERE id=p_run_id FOR UPDATE;
  IF NOT FOUND OR run.status NOT IN ('running','completed','partial')
  THEN RAISE EXCEPTION 'workflow_refresh_not_active'; END IF;
  IF run.lease_token IS DISTINCT FROM p_lease OR run.workflow IS DISTINCT FROM p_owner
     OR run.lease_generation IS DISTINCT FROM p_generation
  THEN RAISE EXCEPTION 'workflow_refresh_lease_mismatch'; END IF;

  SELECT * INTO driver FROM public.workflow_refresh_drivers WHERE workflow=p_owner;
  IF NOT public.workflow_refresh_driver_is_ready(p_owner)
  THEN RAISE EXCEPTION 'workflow_refresh_driver_unavailable'; END IF;
  IF p_driver_version IS DISTINCT FROM driver.declared_output
     OR p_scope IS DISTINCT FROM run.scope
  THEN RAISE EXCEPTION 'workflow_refresh_receipt_scope_mismatch'; END IF;

  IF run.status IN ('completed','partial') THEN
    SELECT * INTO receipt FROM public.workflow_refresh_receipts
     WHERE run_id=p_run_id AND lease_generation=p_generation;
    IF NOT FOUND THEN RAISE EXCEPTION 'workflow_refresh_driver_output_missing'; END IF;
    IF receipt.workflow IS DISTINCT FROM run.workflow
       OR receipt.org_id IS DISTINCT FROM run.org_id
       OR receipt.scope IS DISTINCT FROM run.scope
       OR receipt.driver_version IS DISTINCT FROM p_driver_version
       OR receipt.lease_owner IS DISTINCT FROM p_owner
       OR receipt.lease_token IS DISTINCT FROM p_lease
       OR receipt.lease_generation IS DISTINCT FROM p_generation
       OR receipt.driver_request_id IS DISTINCT FROM run.driver_request_id
       OR receipt.observed_source_revision IS DISTINCT FROM p_observed_revision
       OR receipt.output IS DISTINCT FROM p_output
    THEN RAISE EXCEPTION 'workflow_refresh_receipt_conflict'; END IF;
    RETURN jsonb_build_object(
      'ok',true,'outcome','idempotent','receipt_id',receipt.id,
      'driver_version',receipt.driver_version,
      'observed_source_revision',receipt.observed_source_revision
    );
  END IF;

  IF p_output->>'ok' IS DISTINCT FROM 'true'
     OR p_output->>'declared_output' IS DISTINCT FROM driver.declared_output
     OR p_output->>'observed_source_revision' IS DISTINCT FROM p_observed_revision
     OR p_output#>>'{output_ref,command}' IS DISTINCT FROM 'assess'
  THEN RAISE EXCEPTION 'workflow_refresh_driver_output_invalid'; END IF;

  BEGIN
    output_request_id := (p_output#>>'{output_ref,request_id}')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'workflow_refresh_driver_output_invalid';
  END;
  IF output_request_id IS NULL THEN
    RAISE EXCEPTION 'workflow_refresh_driver_output_invalid';
  END IF;
  IF run.driver_request_id IS NULL
     OR output_request_id IS DISTINCT FROM run.driver_request_id
  THEN RAISE EXCEPTION 'workflow_refresh_driver_output_invalid'; END IF;

  IF p_owner='dispatch' AND driver.validator_key='dispatch_source_v1' THEN
    IF p_output#>>'{output_ref,table}' IS DISTINCT FROM 'dispatch_commands'
    THEN RAISE EXCEPTION 'workflow_refresh_driver_output_invalid'; END IF;
    BEGIN
      expected_job_id := (run.scope->>'job_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'workflow_refresh_driver_output_invalid';
    END;
    SELECT dc.org_id,dc.job_id,dc.created_at,dc.command,dc.result
      INTO command_org_id,command_job_id,command_created_at,command_name,command_result
      FROM public.dispatch_commands dc
     WHERE dc.org_id=run.org_id AND dc.request_id=output_request_id;
    IF NOT FOUND
       OR command_org_id IS DISTINCT FROM run.org_id
       OR command_job_id IS DISTINCT FROM expected_job_id
       OR command_created_at < run.updated_at
       OR command_name IS DISTINCT FROM 'assess'
       OR jsonb_typeof(command_result) IS DISTINCT FROM 'object'
       OR command_result->>'source_version' IS DISTINCT FROM p_observed_revision
       OR command_result->>'live_actions_enabled' IS DISTINCT FROM 'false'
    THEN RAISE EXCEPTION 'workflow_refresh_driver_output_invalid'; END IF;
    IF command_result->>'version' !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'workflow_refresh_driver_output_invalid';
    END IF;
    result_version := (command_result->>'version')::bigint;
    SELECT dp.version,dp.source_version,dp.state
      INTO plan_version,plan_source,plan_state
      FROM public.dispatch_plans dp
     WHERE dp.org_id=run.org_id AND dp.job_id=expected_job_id;
    IF NOT FOUND
       OR plan_version IS DISTINCT FROM result_version
       OR plan_source IS DISTINCT FROM p_observed_revision
       OR plan_state IS DISTINCT FROM command_result->'state'
    THEN RAISE EXCEPTION 'workflow_refresh_driver_output_invalid'; END IF;
  ELSIF p_owner='debt' AND driver.validator_key='debt_source_v1' THEN
    IF p_output#>>'{output_ref,table}' IS DISTINCT FROM 'debt_assess_commands'
       OR to_regclass('public.debt_assess_commands') IS NULL
    THEN RAISE EXCEPTION 'workflow_refresh_driver_output_invalid'; END IF;
    IF nullif(btrim(run.scope->>'xero_invoice_id'),'') IS NOT NULL THEN
      BEGIN
        expected_invoice_id := (run.scope->>'xero_invoice_id')::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'workflow_refresh_driver_output_invalid';
      END;
    ELSIF run.scope->>'population' = 'open' THEN
      expected_invoice_id := '00000000-0000-0000-0000-000000000000'::uuid;
    ELSE
      RAISE EXCEPTION 'workflow_refresh_driver_output_invalid';
    END IF;
    SELECT dac.org_id,dac.xero_invoice_id,dac.created_at,dac.command,dac.result
      INTO command_org_id,command_invoice_id,command_created_at,command_name,command_result
      FROM public.debt_assess_commands dac
     WHERE dac.org_id=run.org_id AND dac.request_id=output_request_id;
    IF NOT FOUND
       OR command_org_id IS DISTINCT FROM run.org_id
       OR command_created_at < run.updated_at
       OR command_name IS DISTINCT FROM 'assess'
       OR jsonb_typeof(command_result) IS DISTINCT FROM 'object'
       OR command_result->>'mode' IS DISTINCT FROM 'assess'
       OR command_result->>'writes' IS DISTINCT FROM 'false'
       OR command_result->>'sends' IS DISTINCT FROM 'false'
       OR command_result->>'live_actions_enabled' IS DISTINCT FROM 'false'
       OR command_result->>'source_version' IS DISTINCT FROM p_observed_revision
    THEN RAISE EXCEPTION 'workflow_refresh_driver_output_invalid'; END IF;
    IF run.scope->>'population' = 'open'
       AND nullif(btrim(run.scope->>'xero_invoice_id'),'') IS NULL
    THEN
      IF command_invoice_id IS NOT NULL
         AND command_invoice_id IS DISTINCT FROM expected_invoice_id
      THEN RAISE EXCEPTION 'workflow_refresh_driver_output_invalid'; END IF;
    ELSIF command_invoice_id IS DISTINCT FROM expected_invoice_id THEN
      RAISE EXCEPTION 'workflow_refresh_driver_output_invalid';
    END IF;
  ELSE
    RAISE EXCEPTION 'workflow_refresh_driver_unavailable';
  END IF;

  source_revision := public.workflow_refresh_source_revision(
    run.workflow, run.org_id, run.scope, driver.validator_key
  );
  IF p_observed_revision IS DISTINCT FROM source_revision
  THEN RAISE EXCEPTION 'workflow_refresh_source_changed'; END IF;

  INSERT INTO public.workflow_refresh_receipts(
    run_id,workflow,org_id,scope,driver_version,lease_owner,lease_token,
    lease_generation,driver_request_id,observed_source_revision,output
  ) VALUES (
    run.id,run.workflow,run.org_id,run.scope,p_driver_version,p_owner,p_lease,
    p_generation,run.driver_request_id,p_observed_revision,p_output
  )
  ON CONFLICT (run_id,lease_generation) DO NOTHING
  RETURNING * INTO receipt;

  IF NOT FOUND THEN
    SELECT * INTO receipt FROM public.workflow_refresh_receipts
     WHERE run_id=p_run_id AND lease_generation=p_generation;
    IF receipt.workflow IS DISTINCT FROM run.workflow
       OR receipt.org_id IS DISTINCT FROM run.org_id
       OR receipt.scope IS DISTINCT FROM run.scope
       OR receipt.driver_version IS DISTINCT FROM p_driver_version
       OR receipt.lease_owner IS DISTINCT FROM p_owner
       OR receipt.lease_token IS DISTINCT FROM p_lease
       OR receipt.lease_generation IS DISTINCT FROM p_generation
       OR receipt.driver_request_id IS DISTINCT FROM run.driver_request_id
       OR receipt.observed_source_revision IS DISTINCT FROM p_observed_revision
       OR receipt.output IS DISTINCT FROM p_output
    THEN RAISE EXCEPTION 'workflow_refresh_receipt_conflict'; END IF;
    RETURN jsonb_build_object(
      'ok',true,'outcome','idempotent','receipt_id',receipt.id,
      'driver_version',receipt.driver_version,
      'observed_source_revision',receipt.observed_source_revision
    );
  END IF;

  RETURN jsonb_build_object(
    'ok',true,'outcome','persisted','receipt_id',receipt.id,
    'driver_version',receipt.driver_version,
    'observed_source_revision',receipt.observed_source_revision
  );
END $$;

CREATE OR REPLACE FUNCTION public.finish_workflow_refresh(
  p_id uuid, p_status text, p_result jsonb, p_cutoff timestamptz,
  p_lease uuid, p_owner text, p_generation integer, p_observed_revision text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  run public.workflow_refresh_runs;
  driver public.workflow_refresh_drivers;
  receipt public.workflow_refresh_receipts;
  current_source_revision text;
  final_status text;
  final_result jsonb;
BEGIN
  IF p_status NOT IN ('completed','partial','failed') OR p_lease IS NULL OR p_generation IS NULL
     OR nullif(btrim(p_owner),'') IS NULL
  THEN RAISE EXCEPTION 'workflow_refresh_invalid'; END IF;

  SELECT * INTO run FROM public.workflow_refresh_runs WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow_refresh_not_active'; END IF;
  IF run.lease_token IS DISTINCT FROM p_lease OR run.workflow IS DISTINCT FROM p_owner
     OR run.lease_generation IS DISTINCT FROM p_generation
  THEN RAISE EXCEPTION 'workflow_refresh_lease_mismatch'; END IF;

  IF run.status IN ('completed','partial') THEN
    SELECT * INTO receipt FROM public.workflow_refresh_receipts
     WHERE run_id=p_id AND lease_generation=p_generation;
    IF NOT FOUND THEN RAISE EXCEPTION 'workflow_refresh_not_active'; END IF;
    IF p_status NOT IN ('completed','partial')
       OR p_observed_revision IS DISTINCT FROM receipt.observed_source_revision
       OR p_result->>'receipt_id' IS DISTINCT FROM receipt.id::text
    THEN RAISE EXCEPTION 'workflow_refresh_receipt_retry_mismatch'; END IF;
    RETURN jsonb_build_object(
      'ok',true,'id',p_id,'status',run.status,'owner',p_owner,
      'result',run.result,'replayed',true
    );
  END IF;
  IF run.status IS DISTINCT FROM 'running'
  THEN RAISE EXCEPTION 'workflow_refresh_lease_mismatch'; END IF;

  final_status := p_status;
  final_result := coalesce(p_result,'{}'::jsonb);
  IF p_status='completed' THEN
    SELECT * INTO driver FROM public.workflow_refresh_drivers WHERE workflow=p_owner;
    IF NOT public.workflow_refresh_driver_is_ready(p_owner)
    THEN RAISE EXCEPTION 'workflow_refresh_driver_unavailable'; END IF;

    SELECT * INTO receipt FROM public.workflow_refresh_receipts
     WHERE run_id=p_id AND lease_generation=p_generation;
    IF NOT FOUND
       OR receipt.workflow IS DISTINCT FROM run.workflow
       OR receipt.org_id IS DISTINCT FROM run.org_id
       OR receipt.scope IS DISTINCT FROM run.scope
       OR receipt.driver_version IS DISTINCT FROM driver.declared_output
       OR receipt.lease_owner IS DISTINCT FROM p_owner
       OR receipt.lease_token IS DISTINCT FROM p_lease
       OR receipt.lease_generation IS DISTINCT FROM p_generation
       OR receipt.driver_request_id IS DISTINCT FROM run.driver_request_id
       OR receipt.observed_source_revision IS NULL
    THEN RAISE EXCEPTION 'workflow_refresh_driver_output_missing'; END IF;

    IF p_observed_revision IS NULL
       OR p_observed_revision IS DISTINCT FROM receipt.observed_source_revision
    THEN RAISE EXCEPTION 'workflow_refresh_receipt_revision_mismatch'; END IF;

    BEGIN
      PERFORM public.record_workflow_refresh_receipt(
        receipt.run_id,receipt.lease_owner,receipt.lease_token,
        receipt.lease_generation,receipt.driver_version,receipt.scope,
        receipt.output,receipt.observed_source_revision
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%workflow_refresh_source_changed%' THEN
        RAISE;
      END IF;
    END;

    current_source_revision := public.workflow_refresh_source_revision(
      run.workflow, run.org_id, run.scope, driver.validator_key
    );
    final_result := jsonb_set(receipt.output, '{receipt_id}', to_jsonb(receipt.id), true);
    IF current_source_revision IS DISTINCT FROM receipt.observed_source_revision THEN
      final_status := 'partial';
      final_result := final_result || jsonb_build_object(
        'completion_note','source_changed_after_assessment',
        'current_source_revision',current_source_revision
      );
    END IF;
  END IF;

  UPDATE public.workflow_refresh_runs
     SET status=final_status, result=final_result, source_cutoff=p_cutoff, updated_at=now()
   WHERE id=p_id;
  RETURN jsonb_build_object('ok',true,'id',p_id,'status',final_status,'owner',p_owner);
END $$;

CREATE OR REPLACE FUNCTION public.consume_workflow_refresh(p_owner text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE run public.workflow_refresh_runs;
BEGIN
  IF NOT public.workflow_refresh_driver_is_ready(p_owner) THEN
    RETURN jsonb_build_object('outcome','unavailable','owner',p_owner,
      'reason','driver_or_validator_not_registered');
  END IF;
  SELECT * INTO run FROM public.workflow_refresh_runs
   WHERE workflow=p_owner AND status='queued'
   ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','idle','owner',p_owner); END IF;
  BEGIN
    RETURN public.claim_workflow_refresh(run.id, p_owner, NULL, NULL);
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.workflow_refresh_runs
       SET status='failed', updated_at=now(),
           result=jsonb_build_object('owner',p_owner,'step','claim_failed','error',SQLERRM)
     WHERE id=run.id;
    RETURN jsonb_build_object('ok',false,'id',run.id,'status','failed',
      'owner',p_owner,'reason','claim_failed');
  END;
END $$;

REVOKE ALL ON FUNCTION public.workflow_refresh_driver_is_ready(text),
 public.workflow_refresh_source_revision(text,uuid,jsonb,text),
 public.record_workflow_refresh_receipt(uuid,text,uuid,integer,text,jsonb,jsonb,text)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_workflow_refresh_receipt(uuid,text,uuid,integer,text,jsonb,jsonb,text)
 TO service_role;

REVOKE ALL ON FUNCTION public.register_workflow_refresh_driver(text,text,text,text,text),
 public.start_workflow_refresh(text,jsonb,text,uuid),
 public.claim_workflow_refresh(uuid,text,uuid,integer),
 public.finish_workflow_refresh(uuid,text,jsonb,timestamptz,uuid,text,integer,text),
 public.workflow_refresh_readback(uuid,uuid),
 public.consume_workflow_refresh(text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.register_workflow_refresh_driver(text,text,text,text,text),
 public.start_workflow_refresh(text,jsonb,text,uuid),
 public.claim_workflow_refresh(uuid,text,uuid,integer),
 public.finish_workflow_refresh(uuid,text,jsonb,timestamptz,uuid,text,integer,text),
 public.workflow_refresh_readback(uuid,uuid),
 public.consume_workflow_refresh(text)
 TO service_role;
