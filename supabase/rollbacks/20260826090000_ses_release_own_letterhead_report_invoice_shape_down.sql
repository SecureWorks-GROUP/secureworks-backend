-- Restore commit_ses_release_revision_v1 to the 20260806010000 body
-- (universal / AJS two / invoice-only). Do not keep the own-letterhead
-- report+invoice ELSIF.

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
  route_count integer;
  kind0 text;
  kind1 text;
  kind2 text;
  universal boolean := false;
  ajs_two boolean := false;
  report_only_one boolean := false;
BEGIN
  IF jsonb_typeof(p_release) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_members) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_members) = 0
     OR jsonb_typeof(p_routes) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'release members and ordered routes are required'
      USING ERRCODE = '22023';
  END IF;

  route_count := jsonb_array_length(p_routes);
  kind0 := p_routes->0->>'route_kind';
  kind1 := p_routes->1->>'route_kind';
  kind2 := p_routes->2->>'route_kind';

  IF route_count = 3
     AND kind0 = 'report'
     AND kind1 = 'photo'
     AND kind2 = 'invoice'
     AND (p_routes->0->>'ordinal')::integer = 0
     AND (p_routes->1->>'ordinal')::integer = 1
     AND (p_routes->2->>'ordinal')::integer = 2 THEN
    universal := true;
  ELSIF route_count = 2
     AND kind0 = 'report_invoice'
     AND kind1 = 'photo'
     AND (p_routes->0->>'ordinal')::integer = 0
     AND (p_routes->1->>'ordinal')::integer = 1 THEN
    ajs_two := true;
  ELSIF route_count = 1
     AND kind0 = 'invoice'
     AND (p_routes->0->>'ordinal')::integer = 0 THEN
    report_only_one := true;
  END IF;

  IF NOT universal AND NOT ajs_two AND NOT report_only_one THEN
    RAISE EXCEPTION
      'release routes must be ordered report/photo/invoice (universal) or report_invoice/photo (AJS)'
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

REVOKE ALL ON FUNCTION public.commit_ses_release_revision_v1(jsonb, jsonb, jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.commit_ses_release_revision_v1(jsonb, jsonb, jsonb)
  TO service_role;
