-- The live-fire cleanup must remove mutable synthetic jobs while preserving the
-- append-only rule for every real job. Readiness invalidations use a RESTRICT
-- job FK, so the exception is one SECURITY DEFINER transaction bound to the
-- immutable run ledger and the exact synthetic marker on every target job.

CREATE OR REPLACE FUNCTION public.assert_synthetic_livefire_purge_job(
  p_marker text,
  p_job_id uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_marker !~ '^SWG-SES-LIVEFIRE-TEST-ONLY-[0-9A-F]{8}-[0-9A-F]{4}-[1-8][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$' THEN
    RAISE EXCEPTION 'invalid synthetic live-fire marker';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.ses_synthetic_livefire_runs run
    JOIN public.jobs job
      ON job.id = p_job_id
     AND job.metadata->>'synthetic_livefire_marker' = run.marker
    WHERE run.marker = p_marker
      AND run.state IN ('active', 'cleanup_complete')
      AND run.job_ids ? p_job_id::text
  ) THEN
    RAISE EXCEPTION
      'job % is not ledger-bound to purgeable synthetic run %',
      p_job_id,
      p_marker;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_synthetic_livefire_purge_job(text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Preserve the U2 invalidation contract except inside the exact ledger-bound
-- cleanup transaction. This also prevents ON DELETE SET NULL case linkage from
-- recreating a RESTRICT readiness row while the synthetic job is being removed.
CREATE OR REPLACE FUNCTION public.invalidate_makesafe_readiness(
  p_job_id uuid,
  p_dependency_kind text,
  p_dependency_identity text,
  p_reason text,
  p_actor text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id uuid;
  v_before bigint;
  v_after bigint;
  v_purge_marker text :=
    current_setting('app.synthetic_livefire_purge_marker', true);
BEGIN
  IF length(btrim(COALESCE(v_purge_marker, ''))) > 0 THEN
    PERFORM public.assert_synthetic_livefire_purge_job(
      v_purge_marker,
      p_job_id
    );
    SELECT dependency_generation
    INTO v_before
    FROM public.makesafe_readiness_current
    WHERE job_id = p_job_id;
    RETURN COALESCE(v_before, 0);
  END IF;

  IF length(btrim(COALESCE(p_dependency_kind, ''))) = 0
     OR length(btrim(COALESCE(p_dependency_identity, ''))) = 0
     OR length(btrim(COALESCE(p_reason, ''))) = 0
     OR length(btrim(COALESCE(p_actor, ''))) = 0 THEN
    RAISE EXCEPTION 'dependency kind, identity, reason and actor are required';
  END IF;
  SELECT org_id INTO v_org_id
  FROM public.jobs
  WHERE id = p_job_id AND type = 'makesafe';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'current make-safe job not found';
  END IF;

  INSERT INTO public.makesafe_readiness_current (job_id, org_id)
  VALUES (p_job_id, v_org_id)
  ON CONFLICT (job_id) DO NOTHING;

  SELECT dependency_generation INTO v_before
  FROM public.makesafe_readiness_current
  WHERE job_id = p_job_id
  FOR UPDATE;
  v_after := v_before + 1;

  UPDATE public.makesafe_readiness_current
  SET dependency_generation = v_after,
      readiness_revision = NULL,
      attendance_cycle_set_hash = NULL,
      family_matrix_revision = NULL,
      ready = false,
      invalidated_at = transaction_timestamp(),
      invalidation_reason = p_reason,
      updated_at = transaction_timestamp()
  WHERE job_id = p_job_id;

  INSERT INTO public.makesafe_readiness_invalidations (
    org_id, job_id, generation_before, generation_after,
    dependency_kind, dependency_identity, reason, actor
  ) VALUES (
    v_org_id, p_job_id, v_before, v_after,
    p_dependency_kind, p_dependency_identity, p_reason, p_actor
  );
  RETURN v_after;
END;
$$;

-- The shared append-only trigger remains fail-closed. Its sole exception is a
-- readiness invalidation DELETE whose OLD job passes the run-ledger assertion.
CREATE OR REPLACE FUNCTION public.reject_makesafe_state_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_purge_marker text :=
    current_setting('app.synthetic_livefire_purge_marker', true);
  v_job_id uuid;
BEGIN
  IF TG_OP = 'DELETE'
     AND TG_TABLE_NAME = 'makesafe_readiness_invalidations'
     AND length(btrim(COALESCE(v_purge_marker, ''))) > 0 THEN
    v_job_id := (to_jsonb(OLD)->>'job_id')::uuid;
    PERFORM public.assert_synthetic_livefire_purge_job(
      v_purge_marker,
      v_job_id
    );
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE OR REPLACE FUNCTION public.purge_synthetic_livefire_jobs(
  p_marker text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ledger_job_ids_json jsonb;
  v_ledger_job_ids uuid[];
  v_ledger_count integer;
  v_marked_count integer;
  v_bound_count integer;
  v_invalidations jsonb := '[]'::jsonb;
  v_current jsonb := '[]'::jsonb;
  v_jobs jsonb := '[]'::jsonb;
BEGIN
  IF p_marker !~ '^SWG-SES-LIVEFIRE-TEST-ONLY-[0-9A-F]{8}-[0-9A-F]{4}-[1-8][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$' THEN
    RAISE EXCEPTION 'invalid synthetic live-fire marker';
  END IF;

  SELECT run.job_ids
  INTO v_ledger_job_ids_json
  FROM public.ses_synthetic_livefire_runs run
  WHERE run.marker = p_marker
    AND run.state IN ('active', 'cleanup_complete')
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'synthetic live-fire run is not purgeable';
  END IF;

  SELECT COALESCE(
    array_agg(DISTINCT value::uuid ORDER BY value::uuid),
    ARRAY[]::uuid[]
  )
  INTO v_ledger_job_ids
  FROM jsonb_array_elements_text(v_ledger_job_ids_json) item(value);
  v_ledger_count := jsonb_array_length(v_ledger_job_ids_json);
  IF cardinality(v_ledger_job_ids) IS DISTINCT FROM v_ledger_count THEN
    RAISE EXCEPTION 'synthetic live-fire ledger job ids are duplicated';
  END IF;

  SELECT count(*) INTO v_marked_count
  FROM public.jobs job
  WHERE job.metadata->>'synthetic_livefire_marker' = p_marker;
  SELECT count(*) INTO v_bound_count
  FROM public.jobs job
  WHERE job.id = ANY(v_ledger_job_ids)
    AND job.metadata->>'synthetic_livefire_marker' = p_marker;
  IF v_marked_count > v_ledger_count OR v_bound_count <> v_marked_count THEN
    RAISE EXCEPTION
      'synthetic live-fire purge scope mismatch: ledger %, marked %, bound %',
      v_ledger_count,
      v_marked_count,
      v_bound_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.ses_external_effects
    WHERE job_id = ANY(v_ledger_job_ids)
  ) OR EXISTS (
    SELECT 1 FROM public.xero_invoices
    WHERE job_id = ANY(v_ledger_job_ids)
  ) OR EXISTS (
    SELECT 1 FROM public.trade_invoice_lines
    WHERE job_id = ANY(v_ledger_job_ids)
  ) OR EXISTS (
    SELECT 1 FROM public.makesafe_docket_revisions
    WHERE job_id = ANY(v_ledger_job_ids)
  ) OR EXISTS (
    SELECT 1 FROM public.makesafe_release_revision_members
    WHERE job_id = ANY(v_ledger_job_ids)
  ) OR EXISTS (
    SELECT 1 FROM public.makesafe_revision_approvals
    WHERE job_id = ANY(v_ledger_job_ids)
  ) OR EXISTS (
    SELECT 1 FROM public.makesafe_board_status_applications
    WHERE job_id = ANY(v_ledger_job_ids)
  ) OR EXISTS (
    SELECT 1 FROM public.makesafe_readiness_revisions
    WHERE job_id = ANY(v_ledger_job_ids)
  ) THEN
    RAISE EXCEPTION
      'synthetic live-fire purge refused money, release, docket, projection, or committed-readiness residue';
  END IF;

  PERFORM set_config('app.synthetic_livefire_purge_marker', p_marker, true);

  WITH deleted AS (
    DELETE FROM public.makesafe_readiness_invalidations
    WHERE job_id = ANY(v_ledger_job_ids)
    RETURNING id, job_id
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object('id', id, 'job_id', job_id)
      ORDER BY job_id, id
    ),
    '[]'::jsonb
  )
  INTO v_invalidations
  FROM deleted;

  WITH deleted AS (
    DELETE FROM public.makesafe_readiness_current
    WHERE job_id = ANY(v_ledger_job_ids)
    RETURNING job_id
  )
  SELECT COALESCE(jsonb_agg(job_id ORDER BY job_id), '[]'::jsonb)
  INTO v_current
  FROM deleted;

  WITH deleted AS (
    DELETE FROM public.jobs
    WHERE id = ANY(v_ledger_job_ids)
      AND metadata->>'synthetic_livefire_marker' = p_marker
    RETURNING id
  )
  SELECT COALESCE(jsonb_agg(id ORDER BY id), '[]'::jsonb)
  INTO v_jobs
  FROM deleted;

  IF jsonb_array_length(v_jobs) <> v_ledger_count THEN
    RAISE EXCEPTION
      'synthetic live-fire job purge deleted % of % jobs',
      jsonb_array_length(v_jobs),
      v_ledger_count;
  END IF;

  RETURN jsonb_build_object(
    'marker', p_marker,
    'jobs_deleted', v_jobs,
    'readiness_current_deleted', v_current,
    'readiness_invalidations_deleted', v_invalidations
  );
END;
$$;

REVOKE ALL ON FUNCTION public.purge_synthetic_livefire_jobs(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_synthetic_livefire_jobs(text)
  TO service_role, postgres;

COMMENT ON FUNCTION public.purge_synthetic_livefire_jobs(text) IS
  'Deletes only the exact mutable jobs in an active synthetic live-fire run ledger, with a transaction-scoped exception for their append-only readiness invalidations. Refuses any scope mismatch or money/release/docket/projection/committed-readiness residue.';
