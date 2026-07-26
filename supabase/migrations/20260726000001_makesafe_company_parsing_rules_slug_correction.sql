-- Correct the 20260704000002 parsing-rule seed aliases to the live company slugs.
-- Apply before the matching deterministic intake edge deploy.
--
-- The original migration targeted ajs/ajbr, builderwest and western-building,
-- while production uses aj, bw and wb. Its non-clobber guard remains load-bearing:
-- reviewed or hand-tuned field rules are never overwritten.
DO $$
DECLARE
  common_fields jsonb := jsonb_build_object(
    'client_name', jsonb_build_object(
      'regex', '(?:client|insured|customer|home\s*owner|homeowner|owner)\s*(?:name)?\s*[:\-]\s*([A-Za-z][A-Za-z''\-\. ]{1,60})',
      'source', 'all', 'group', 1, 'transform', 'collapse_ws'),
    'client_phone', jsonb_build_object(
      'regex', '(?:phone|mobile|contact|ph|tel)\s*(?:no\.?|number)?\s*[:\-]\s*(\+?[0-9][0-9 ()\-]{6,})',
      'source', 'all', 'group', 1, 'transform', 'collapse_ws'),
    'site_address', jsonb_build_object(
      'regex', '(?:site\s*address|risk\s*address|property\s*address|address|property|site)\s*[:\-]\s*([0-9][^\n\r]{4,80})',
      'source', 'all', 'group', 1, 'transform', 'collapse_ws')
  );
  uncovered_slugs text[];
BEGIN
  UPDATE public.makesafe_companies
  SET parsing_rules = jsonb_build_object(
    'version', 2,
    'template_first', false,
    'confidence', 'high',
    'required', jsonb_build_array('external_ref', 'client_name', 'site_address'),
    'fields', common_fields || jsonb_build_object(
      'external_ref', jsonb_build_object(
        'regex', '\b((?:AJBR|AJS)[-\s]?\d{3,8}|Job\s*No\.?\s*[:#-]?\s*\d{3,8})\b',
        'source', 'all', 'group', 1, 'transform', 'upper'))
  )
  WHERE slug IN ('aj', 'ajs', 'ajbr')
    AND active
    AND NOT (COALESCE(parsing_rules, '{}'::jsonb) ? 'fields');

  UPDATE public.makesafe_companies
  SET parsing_rules = jsonb_build_object(
    'version', 2,
    'template_first', false,
    'confidence', 'high',
    'required', jsonb_build_array('external_ref', 'client_name', 'site_address'),
    'fields', common_fields || jsonb_build_object(
      'external_ref', jsonb_build_object(
        'regex', '\b((?:BWCWA|BWC|BW)[-\s]?\d{3,8})\b',
        'source', 'all', 'group', 1, 'transform', 'upper'))
  )
  WHERE slug IN ('bw', 'builderwest')
    AND active
    AND NOT (COALESCE(parsing_rules, '{}'::jsonb) ? 'fields');

  UPDATE public.makesafe_companies
  SET parsing_rules = jsonb_build_object(
    'version', 2,
    'template_first', false,
    'confidence', 'high',
    'required', jsonb_build_array('external_ref', 'client_name', 'site_address'),
    'fields', common_fields || jsonb_build_object(
      'external_ref', jsonb_build_object(
        'regex', '\b(WB[-\s]?\d{3,8})\b',
        'source', 'all', 'group', 1, 'transform', 'upper'))
  )
  WHERE slug IN ('wb', 'western-building')
    AND active
    AND NOT (COALESCE(parsing_rules, '{}'::jsonb) ? 'fields');

  -- Coverage is explicit and fail-closed. A company may intentionally run with
  -- no field rules only when parsing_rules carries both:
  --   "intentionally_no_fields": true
  --   "no_fields_reason": "reviewed reason"
  -- There are no intentional exceptions in the current five-company live set.
  SELECT array_agg(slug ORDER BY slug)
  INTO uncovered_slugs
  FROM public.makesafe_companies
  WHERE active
    AND NOT (COALESCE(parsing_rules, '{}'::jsonb) ? 'fields')
    AND NOT (
      COALESCE(parsing_rules->>'intentionally_no_fields', 'false') = 'true'
      AND length(trim(COALESCE(parsing_rules->>'no_fields_reason', ''))) > 0
    );

  IF COALESCE(array_length(uncovered_slugs, 1), 0) > 0 THEN
    RAISE EXCEPTION
      'Active make-safe company parsing-rule coverage missing for slugs: %',
      array_to_string(uncovered_slugs, ', ');
  END IF;

  -- Keep the coverage law alive after this one-shot correction. Future active
  -- company inserts and activations must carry rules or an explicit reviewed
  -- no-rules declaration; a migration-time assertion alone would drift again.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.makesafe_companies'::regclass
      AND conname = 'makesafe_companies_active_parsing_rules_covered'
  ) THEN
    ALTER TABLE public.makesafe_companies
      ADD CONSTRAINT makesafe_companies_active_parsing_rules_covered
      CHECK (
        NOT active
        OR COALESCE(parsing_rules, '{}'::jsonb) ? 'fields'
        OR (
          COALESCE(parsing_rules->>'intentionally_no_fields', 'false') = 'true'
          AND length(trim(COALESCE(parsing_rules->>'no_fields_reason', ''))) > 0
        )
      ) NOT VALID;
  END IF;

  ALTER TABLE public.makesafe_companies
    VALIDATE CONSTRAINT makesafe_companies_active_parsing_rules_covered;
END $$;
