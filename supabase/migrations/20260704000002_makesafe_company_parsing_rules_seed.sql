-- ════════════════════════════════════════════════════════════
-- MAKE-SAFE INTAKE — per-builder template parsing_rules seed
-- Mission: makesafe/intake-cost-hardening (Auto-Intake v2 Wave 1 M1.5)
-- ════════════════════════════════════════════════════════════
--
-- Seeds makesafe_companies.parsing_rules for the highest-volume builders with
-- deterministic field regexes, so the intake scan can lift the required fields without
-- a Haiku classifier call. The rules are DATA (editable in one UPDATE, no redeploy) —
-- see makesafe_template_parser.ts for the shape and semantics.
--
-- SAFE ROLLOUT — every builder is seeded with template_first:false. Until the Captain
-- flips a builder to template_first:true (only AFTER intake_golden_replay proves the
-- template output agrees with the live model on that builder's real emails), the live
-- scan STILL calls the model; the template parse runs only as a preview. So no builder
-- goes template-first blind.
--
-- The external_ref regex is the reliable deterministic field (stable ref prefixes,
-- derived from slugFromRefPrefix + the intake ref regex already in the repo). The
-- client / address / phone regexes are best-effort label patterns; when they don't
-- match, the parse is not "full" and the model is still called — a miss costs a model
-- call, never a wrong extraction. Confidence is stamped 'high' only on a full parse.
--
-- IDEMPOTENT + NON-CLOBBERING: each UPDATE guards on `NOT (parsing_rules ? 'fields')`,
-- so re-applying is a no-op and a hand-tuned rule set is never overwritten.

-- Shared best-effort label rules for the human-entered fields. Builders vary the exact
-- labels; these cover the common forms. Body + PDF text are both searched ('all').
-- client_name / site_address are required for a full parse; client_phone is optional.
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
BEGIN
  -- MLB (ML Builders / primeeco.tech) — refs like "MLB-25795".
  UPDATE public.makesafe_companies
  SET parsing_rules = jsonb_build_object(
    'version', 1,
    'template_first', false,
    'confidence', 'high',
    'required', jsonb_build_array('external_ref', 'client_name', 'site_address'),
    'fields', common_fields || jsonb_build_object(
      'external_ref', jsonb_build_object(
        'regex', '\b(MLB[-\s]?\d{4,6})\b', 'source', 'all', 'group', 1, 'transform', 'upper'))
  )
  WHERE slug = 'mlb' AND active AND NOT (parsing_rules ? 'fields');

  -- Builderwest (BWCWA / BWC / BW prefixes).
  UPDATE public.makesafe_companies
  SET parsing_rules = jsonb_build_object(
    'version', 1,
    'template_first', false,
    'confidence', 'high',
    'required', jsonb_build_array('external_ref', 'client_name', 'site_address'),
    'fields', common_fields || jsonb_build_object(
      'external_ref', jsonb_build_object(
        'regex', '\b((?:BWCWA|BWC|BW)[-\s]?\d{3,6})\b', 'source', 'all', 'group', 1, 'transform', 'upper'))
  )
  WHERE slug = 'builderwest' AND active AND NOT (parsing_rules ? 'fields');

  -- Western Building (WB prefix).
  UPDATE public.makesafe_companies
  SET parsing_rules = jsonb_build_object(
    'version', 1,
    'template_first', false,
    'confidence', 'high',
    'required', jsonb_build_array('external_ref', 'client_name', 'site_address'),
    'fields', common_fields || jsonb_build_object(
      'external_ref', jsonb_build_object(
        'regex', '\b(WB[-\s]?\d{3,6})\b', 'source', 'all', 'group', 1, 'transform', 'upper'))
  )
  WHERE slug = 'western-building' AND active AND NOT (parsing_rules ? 'fields');

  -- KBA Insurance Repairs (KBA prefix).
  UPDATE public.makesafe_companies
  SET parsing_rules = jsonb_build_object(
    'version', 1,
    'template_first', false,
    'confidence', 'high',
    'required', jsonb_build_array('external_ref', 'client_name', 'site_address'),
    'fields', common_fields || jsonb_build_object(
      'external_ref', jsonb_build_object(
        'regex', '\b(KBA[-\s]?\d{3,6})\b', 'source', 'all', 'group', 1, 'transform', 'upper'))
  )
  WHERE slug = 'kba' AND active AND NOT (parsing_rules ? 'fields');

  -- AJS (AJS / AJBR refs) — seeded if a matching company row exists.
  UPDATE public.makesafe_companies
  SET parsing_rules = jsonb_build_object(
    'version', 1,
    'template_first', false,
    'confidence', 'high',
    'required', jsonb_build_array('external_ref', 'client_name', 'site_address'),
    'fields', common_fields || jsonb_build_object(
      'external_ref', jsonb_build_object(
        'regex', '\b((?:AJBR|AJS)[-\s]?\d{3,6})\b', 'source', 'all', 'group', 1, 'transform', 'upper'))
  )
  WHERE slug IN ('ajs', 'ajbr') AND active AND NOT (parsing_rules ? 'fields');
END $$;
