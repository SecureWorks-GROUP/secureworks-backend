-- SES release: allow AJS/AJBR two-route shape (report_invoice + photo).
--
-- Captain 2026-08-04 / skill backend release contract:
--   AJS: report_invoice then photo (not the universal three-email split).
--   MLB: report, photo, invoice unchanged.
--
-- Widens route_kind CHECKs and rewrites commit_ses_release_revision_v1 so a
-- two-route AJS release can be stored. No operational rows written.

BEGIN;

-- Drop any CHECK that constrains route_kind on the three tables (names vary
-- between inline CHECK and named constraints across environments).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname, rel.relname
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE c.contype = 'c'
      AND n.nspname = 'public'
      AND rel.relname IN (
        'makesafe_release_revision_routes',
        'ses_external_effects',
        'ses_release_route_proofs'
      )
      AND pg_get_constraintdef(c.oid) ILIKE '%route_kind%'
      AND pg_get_constraintdef(c.oid) ILIKE '%report%'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I DROP CONSTRAINT %I',
      r.relname,
      r.conname
    );
  END LOOP;
END $$;

ALTER TABLE public.makesafe_release_revision_routes
  ADD CONSTRAINT makesafe_release_revision_routes_route_kind_check
  CHECK (route_kind IN ('report', 'photo', 'invoice', 'report_invoice'));

ALTER TABLE public.ses_external_effects
  ADD CONSTRAINT ses_external_effects_route_kind_check
  CHECK (
    route_kind IS NULL OR
    route_kind IN ('report', 'photo', 'invoice', 'report_invoice')
  );

ALTER TABLE public.ses_release_route_proofs
  ADD CONSTRAINT ses_release_route_proofs_route_kind_check
  CHECK (route_kind IN ('report', 'photo', 'invoice', 'report_invoice'));

-- Accept either universal three-route or AJS two-route ordered sets.
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
  END IF;

  IF NOT universal AND NOT ajs_two THEN
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

COMMIT;
