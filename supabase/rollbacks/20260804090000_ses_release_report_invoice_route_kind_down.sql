-- Rollback: remove report_invoice route kind and restore three-route-only commit.
-- Refuses if any live row already uses report_invoice.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.makesafe_release_revision_routes
    WHERE route_kind = 'report_invoice'
  ) OR EXISTS (
    SELECT 1 FROM public.ses_external_effects
    WHERE route_kind = 'report_invoice'
  ) OR EXISTS (
    SELECT 1 FROM public.ses_release_route_proofs
    WHERE route_kind = 'report_invoice'
  ) THEN
    RAISE EXCEPTION
      'cannot rollback ses report_invoice route kind while live rows use it';
  END IF;
END $$;

ALTER TABLE public.makesafe_release_revision_routes
  DROP CONSTRAINT IF EXISTS makesafe_release_revision_routes_route_kind_check;
ALTER TABLE public.makesafe_release_revision_routes
  ADD CONSTRAINT makesafe_release_revision_routes_route_kind_check
  CHECK (route_kind IN ('report', 'photo', 'invoice'));

ALTER TABLE public.ses_external_effects
  DROP CONSTRAINT IF EXISTS ses_external_effects_route_kind_check;
ALTER TABLE public.ses_external_effects
  ADD CONSTRAINT ses_external_effects_route_kind_check
  CHECK (
    route_kind IS NULL OR route_kind IN ('report', 'photo', 'invoice')
  );

ALTER TABLE public.ses_release_route_proofs
  DROP CONSTRAINT IF EXISTS ses_release_route_proofs_route_kind_check;
ALTER TABLE public.ses_release_route_proofs
  ADD CONSTRAINT ses_release_route_proofs_route_kind_check
  CHECK (route_kind IN ('report', 'photo', 'invoice'));

-- Restore original three-route-only commit body from 20260728020000.
CREATE OR REPLACE FUNCTION public.commit_ses_release_revision_v1(
  p_release jsonb,
  p_members jsonb,
  p_routes jsonb
)
RETURNS public.makesafe_release_revisions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target public.makesafe_release_revisions%ROWTYPE;
  member jsonb;
  route jsonb;
BEGIN
  IF jsonb_typeof(p_release) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_members) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_members) = 0
     OR jsonb_typeof(p_routes) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_routes) <> 3
     OR p_routes->0->>'route_kind' IS DISTINCT FROM 'report'
     OR p_routes->1->>'route_kind' IS DISTINCT FROM 'photo'
     OR p_routes->2->>'route_kind' IS DISTINCT FROM 'invoice'
     OR (p_routes->0->>'ordinal')::integer IS DISTINCT FROM 0
     OR (p_routes->1->>'ordinal')::integer IS DISTINCT FROM 1
     OR (p_routes->2->>'ordinal')::integer IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'release members and the ordered report, photo, invoice routes are required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('ses-release:' || (p_release->>'id'), 0)
  );
  SELECT * INTO target
  FROM public.makesafe_release_revisions
  WHERE id = (p_release->>'id')::uuid;
  IF FOUND THEN
    IF target.content_hash = p_release->>'content_hash' THEN
      RETURN target;
    END IF;
    RAISE EXCEPTION 'release revision id resolves to different content'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.makesafe_release_revisions (
    id, org_id, content_hash, state, dependency_generation,
    readiness_bindings, created_by
  ) VALUES (
    (p_release->>'id')::uuid,
    (p_release->>'org_id')::uuid,
    p_release->>'content_hash',
    'proposed',
    (p_release->>'dependency_generation')::bigint,
    p_release->'readiness_bindings',
    p_release->>'created_by'
  ) RETURNING * INTO target;

  FOR member IN SELECT value FROM jsonb_array_elements(p_members) ORDER BY (value->>'ordinal')::integer
  LOOP
    INSERT INTO public.makesafe_release_revision_members (
      release_revision_id, ordinal, job_id, docket_revision_id,
      invoice_obligation_revision_id, attendance_cycle_ids
    ) VALUES (
      target.id,
      (member->>'ordinal')::integer,
      (member->>'job_id')::uuid,
      (member->>'docket_revision_id')::uuid,
      NULLIF(member->>'invoice_obligation_revision_id', '')::uuid,
      ARRAY(
        SELECT value::uuid
        FROM jsonb_array_elements_text(member->'attendance_cycle_ids')
        ORDER BY value::uuid
      )
    );
  END LOOP;

  FOR route IN SELECT value FROM jsonb_array_elements(p_routes) ORDER BY (value->>'ordinal')::integer
  LOOP
    INSERT INTO public.makesafe_release_revision_routes (
      release_revision_id, ordinal, route_kind, recipients, cc, subject,
      body, body_hash, attachment_hashes, envelope_hash, required
    ) VALUES (
      target.id,
      (route->>'ordinal')::integer,
      route->>'route_kind',
      ARRAY(SELECT jsonb_array_elements_text(route->'recipients')),
      ARRAY(SELECT jsonb_array_elements_text(COALESCE(route->'cc', '[]'::jsonb))),
      route->>'subject',
      route->>'body',
      route->>'body_hash',
      ARRAY(SELECT jsonb_array_elements_text(COALESCE(route->'attachment_hashes', '[]'::jsonb))),
      route->>'envelope_hash',
      COALESCE((route->>'required')::boolean, true)
    );
  END LOOP;
  RETURN target;
END;
$$;

COMMIT;
